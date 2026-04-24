import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

/**
 * Re-analyze previously-analyzed WhatsApp messages against the CURRENT
 * server prompt + code. Use this when:
 *
 *   - The analyzer prompt has been updated with a new rule, and one or
 *     more historical messages would now be classified differently.
 *   - A bug in sender resolution caused messages to be silently dropped,
 *     and the fix is in place.
 *
 * Flow: delete the AnalyzedMessage rows (clearing the dedupe key), then
 * POST to /api/whatsapp/analyze so the server re-runs the full pipeline
 * — LLM classification, sender resolution, verdict execution, slot
 * emojis, everything. Note: this RESENDS reacts/replies to the group
 * via the next due-posts cycle if the verdict emits them. For silent
 * re-runs where you only want attendance/score writes without a
 * user-visible reply, skip this and register manually instead.
 *
 * Usage:
 *   pnpm tsx scripts/reanalyze-messages.ts <waMessageId> [<waMessageId>...]
 */
async function main() {
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
    console.error("Usage: reanalyze-messages.ts <waMessageId> [...]");
    process.exit(1);
  }

  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const rows = await db.analyzedMessage.findMany({
    where: { waMessageId: { in: ids } },
    orderBy: { createdAt: "asc" },
  });
  if (rows.length === 0) {
    console.error("No AnalyzedMessage rows match those IDs.");
    process.exit(1);
  }

  // All rows must be in the same org for a single POST. Validate.
  const groupIds = new Set(rows.map((r) => r.groupId));
  if (groupIds.size !== 1) {
    throw new Error(`Messages span multiple groups: ${[...groupIds].join(", ")}`);
  }
  const groupId = [...groupIds][0];
  const org = await db.organisation.findFirst({
    where: { id: rows[0].orgId },
    select: { id: true, name: true, whatsappBotEnabled: true },
  });
  if (!org?.whatsappBotEnabled) throw new Error("Org doesn't have bot enabled");

  // Build the InboundMessage payload. Look up authorName from User.
  const userIds = [...new Set(rows.map((r) => r.authorUserId).filter(Boolean))];
  const users = await db.user.findMany({
    where: { id: { in: userIds as string[] } },
    select: { id: true, name: true },
  });
  const nameById = new Map(users.map((u) => [u.id, u.name ?? ""]));

  // Build a history window: recent AnalyzedMessage rows + SentNotification
  // group posts that preceded the target messages. The LLM needs this
  // context for rules like "short confirmation after pending-list" where
  // the previous bot message defines the referent.
  const earliestTarget = rows[0].createdAt;
  const windowStart = new Date(earliestTarget.getTime() - 2 * 60 * 60 * 1000);
  const [histRows, histBotPosts] = await Promise.all([
    db.analyzedMessage.findMany({
      where: {
        groupId,
        createdAt: { gte: windowStart, lt: earliestTarget },
        NOT: { waMessageId: { in: ids } },
      },
      orderBy: { createdAt: "asc" },
      take: 30,
    }),
    db.sentNotification.findMany({
      where: {
        kind: "group-message",
        createdAt: { gte: windowStart, lt: earliestTarget },
        match: { activity: { orgId: org.id } },
      },
      orderBy: { createdAt: "asc" },
      take: 30,
    }),
  ]);
  const histUsers = await db.user.findMany({
    where: { id: { in: [...new Set(histRows.map((h) => h.authorUserId).filter(Boolean))] as string[] } },
    select: { id: true, name: true },
  });
  const histNameById = new Map(histUsers.map((u) => [u.id, u.name ?? ""]));

  type H = { authorName: string; body: string; timestamp: string };
  const history: H[] = [
    ...histRows.map((r) => ({
      authorName: r.authorUserId ? histNameById.get(r.authorUserId) ?? "unknown" : "unknown",
      body: r.body ?? "",
      timestamp: r.createdAt.toISOString(),
    })),
    ...histBotPosts.map((s) => ({
      authorName: "MatchTime",
      body: "", // SentNotification doesn't store the rendered text; use the key as a hint
      timestamp: s.createdAt.toISOString(),
    })),
  ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const payload = {
    groupId,
    messages: rows.map((r) => ({
      waMessageId: r.waMessageId,
      body: r.body ?? "",
      authorPhone: r.authorPhone ?? "",
      authorName: r.authorUserId ? nameById.get(r.authorUserId) ?? null : null,
      timestamp: r.createdAt.toISOString(),
    })),
    history,
  };

  console.log(`Clearing ${rows.length} AnalyzedMessage rows for reprocessing...`);
  await db.analyzedMessage.deleteMany({ where: { waMessageId: { in: ids } } });

  const baseUrl = process.env.NEXTAUTH_URL?.replace(/\/$/, "") ?? "https://matchtime.ai";
  const apiKey = process.env.WHATSAPP_API_KEY;
  if (!apiKey) throw new Error("WHATSAPP_API_KEY not set");

  console.log(`POSTing ${rows.length} messages to ${baseUrl}/api/whatsapp/analyze ...`);
  const res = await fetch(`${baseUrl}/api/whatsapp/analyze`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(payload),
  });
  const out = await res.json();
  console.log(JSON.stringify(out, null, 2));

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
