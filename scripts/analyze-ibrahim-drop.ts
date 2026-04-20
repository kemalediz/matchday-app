/**
 * One-off demo of Phase 3: push Ibrahim's "replace me, ankle sore"
 * message through the smart-analysis endpoint so we can watch the
 * full pipeline execute end-to-end. wweb.js's catch-up fetchMessages
 * is still broken on this session so the bot couldn't pick this up
 * retroactively on its own; feeding it directly to the server
 * reproduces the exact flow Claude will take on similar future
 * messages.
 *
 * Side-effects (if everything works):
 *   - Ibrahim's attendance for the Tuesday match flips to DROPPED
 *   - An `AnalyzedMessage` row is written with intent=replacement_request
 *   - Server returns a `reply` text; this script queues it as a
 *     BotJob so the bot posts it to the group.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const ANALYZE_URL = "https://matchtime.ai/api/whatsapp/analyze";
const GROUP_ID = "447525334985-1607872139@g.us";
const IBRAHIM_PHONE = "+447385849848";
const MESSAGE_BODY = "Anybody would be willing to replace me ? My ankle is still a bit sore";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const apiKey = process.env.WHATSAPP_API_KEY;
  if (!apiKey) throw new Error("WHATSAPP_API_KEY not set in env");

  const now = Date.now();
  const body = {
    groupId: GROUP_ID,
    history: [],
    messages: [
      {
        waMessageId: `manual-ibrahim-drop-${now}`,
        body: MESSAGE_BODY,
        authorPhone: IBRAHIM_PHONE,
        authorName: "Ibrahim Sahin",
        timestamp: new Date(now - 7 * 60 * 60 * 1000).toISOString(),
      },
    ],
  };

  console.log(`POST ${ANALYZE_URL}`);
  const res = await fetch(ANALYZE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  console.log(`Status: ${res.status}`);
  console.log(text);

  if (!res.ok) process.exit(1);

  const json = JSON.parse(text) as {
    ok: boolean;
    results: Array<{ intent: string; reply: string | null; react: string | null }>;
  };

  const result = json.results[0];
  if (!result) {
    console.log("No results — nothing else to do.");
    await db.$disconnect();
    return;
  }

  console.log(`\nIntent: ${result.intent}`);
  console.log(`React: ${result.react ?? "-"}`);
  console.log(`Reply: ${result.reply ?? "-"}`);

  // Queue the reply as a BotJob so the bot posts it to the group.
  if (result.reply) {
    const org = await db.organisation.findFirst({ where: { whatsappGroupId: GROUP_ID } });
    if (!org) throw new Error("Sutton org not found");
    const job = await db.botJob.create({
      data: {
        orgId: org.id,
        kind: "group",
        phone: null,
        text: result.reply,
      },
    });
    console.log(`\nQueued BotJob ${job.id} — bot will post within ~5 min.`);
  } else {
    console.log("\nNo reply text from analyzer — nothing queued.");
  }

  // Show updated attendance so we can confirm Ibrahim is marked DROPPED.
  const ibrahim = await db.user.findFirst({
    where: { name: { startsWith: "Ibrahim" } },
    select: { id: true, name: true },
  });
  if (ibrahim) {
    const attendance = await db.attendance.findFirst({
      where: {
        userId: ibrahim.id,
        match: { activity: { orgId: (await db.organisation.findFirst({ where: { whatsappGroupId: GROUP_ID } }))!.id } },
        status: { in: ["CONFIRMED", "BENCH", "DROPPED"] },
      },
      include: { match: { select: { id: true } } },
      orderBy: { createdAt: "desc" },
    });
    console.log(`\n${ibrahim.name} attendance: ${attendance?.status ?? "(none)"}`);
  }

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
