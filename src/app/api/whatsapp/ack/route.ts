/**
 * Bot reports back after executing a due instruction. Writes a
 * SentNotification row so the same key won't fire again. For bench prompts
 * we also patch the waMessageId onto the PendingBenchConfirmation so the
 * reaction handler can look it up.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { key, kind, matchId, targetUser, waMessageId, benchUserId } = body as {
    key: string;
    kind: string;
    matchId?: string;
    targetUser?: string;
    waMessageId?: string;
    benchUserId?: string; // for bench-prompt kind
  };

  if (!key || !kind) {
    return NextResponse.json({ error: "key and kind required" }, { status: 400 });
  }

  await db.sentNotification.upsert({
    where: { key },
    create: { key, kind, matchId, targetUser, waMessageId },
    update: { waMessageId: waMessageId ?? undefined },
  });

  // Link bench prompts so reactions can find the right PendingBenchConfirmation.
  if (kind === "bench-prompt" && waMessageId && matchId && benchUserId) {
    await db.pendingBenchConfirmation.updateMany({
      where: { matchId, userId: benchUserId, resolvedAt: null },
      data: { waMessageId },
    });
  }

  // BotJob keys look like `botjob-<id>`; close them out so they don't
  // re-enqueue on the next poll.
  if (key.startsWith("botjob-")) {
    const botJobId = key.slice("botjob-".length);
    await db.botJob.update({
      where: { id: botJobId },
      data: { sentAt: new Date() },
    }).catch(() => {}); // tolerate already-sent or deleted rows
  }

  return NextResponse.json({ ok: true });
}
