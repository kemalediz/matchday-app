/**
 * Record that the bot's regex fast-path handled a WhatsApp message,
 * so the periodic catch-up scan doesn't feed it to Claude again.
 *
 * Body shape (one per call — bot calls this from handlers.ts):
 *   { groupId, waMessageId, body, authorPhone, authorName, handledBy, action }
 *
 * `handledBy` is one of: "fast-path" (regex ran) | "ignored" (silent
 * drop — @lid, unknown phone, empty). The payload populates the same
 * `AnalyzedMessage` row the smart path uses, giving a single source of
 * truth for "have we seen this waMessageId yet?".
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "bad body" }, { status: 400 });
  }

  const {
    groupId,
    waMessageId,
    authorPhone,
    body: msgBody,
    handledBy,
    action,
    intent,
  } = body as {
    groupId?: string;
    waMessageId?: string;
    authorPhone?: string;
    body?: string;
    handledBy?: string;
    action?: string;
    intent?: string;
  };

  if (!groupId || !waMessageId || !handledBy) {
    return NextResponse.json(
      { error: "groupId, waMessageId, handledBy required" },
      { status: 400 },
    );
  }

  const org = await db.organisation.findFirst({
    where: { whatsappGroupId: groupId },
    select: { id: true },
  });
  if (!org) {
    return NextResponse.json({ ok: true, ignored: "unknown-group" });
  }

  try {
    await db.analyzedMessage.upsert({
      where: { waMessageId },
      create: {
        waMessageId,
        orgId: org.id,
        groupId,
        authorPhone: authorPhone ?? null,
        body: (msgBody ?? "").slice(0, 2000),
        handledBy,
        intent: intent ?? null,
        action: action ?? null,
      },
      update: {
        // If somehow we saw it twice, keep the richer record. Preserve
        // the original handledBy tag.
        intent: intent ?? undefined,
        action: action ?? undefined,
      },
    });
  } catch (err) {
    console.error("[mark-handled] upsert failed:", err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
