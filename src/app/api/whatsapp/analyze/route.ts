/**
 * Smart-analysis entry point. Called by the bot for any WhatsApp group
 * message the regex fast-path didn't handle — either inline (one
 * message at a time) or in a catch-up batch (startup / periodic scan).
 *
 * Flow per message:
 *   1. Skip if `waMessageId` already in `AnalyzedMessage` (dedupe across
 *      inline + catch-up paths).
 *   2. Resolve author phone → User → Membership (auto-onboard new
 *      members the same way /api/whatsapp/attendance does).
 *   3. Hand message + squad + history to `analyzeMessage()` (Claude).
 *   4. Execute the verdict:
 *        - register IN/OUT  → lib/attendance.ts
 *        - react             → returned to bot; bot calls msg.react()
 *        - reply             → returned to bot; bot posts in group
 *   5. Record the outcome in `AnalyzedMessage` so the same waMessageId
 *      can't be analysed twice.
 *
 * The bot sends `actions[]` back to WhatsApp itself (we can't from
 * here — WhatsApp sessions live on the Pi). The API just computes what
 * *should* happen.
 *
 * Request shape:
 *   {
 *     groupId: "xxx@g.us",
 *     history: [{authorName, body, timestamp}],
 *     messages: [{waMessageId, body, authorPhone, authorName, timestamp}]
 *   }
 *
 * Response shape:
 *   {
 *     ok: true,
 *     results: [
 *       { waMessageId, handledBy, intent, actions: {react?, reply?} }
 *     ]
 *   }
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { normalisePhone } from "@/lib/phone";
import { analyzeMessage, type AnalysisResult } from "@/lib/message-analyzer";
import { registerAttendance, cancelAttendance } from "@/lib/attendance";

interface InboundMessage {
  waMessageId: string;
  body: string;
  authorPhone: string;
  authorName: string | null;
  timestamp: string; // ISO
}

interface InboundHistory {
  authorName: string | null;
  body: string;
  timestamp: string; // ISO
}

interface InboundBody {
  groupId: string;
  history?: InboundHistory[];
  messages: InboundMessage[];
}

type ActionForBot = {
  waMessageId: string;
  handledBy: "fast-path" | "llm" | "ignored" | "error" | "deduped";
  intent: string | null;
  react: string | null;
  reply: string | null;
  reasoning?: string;
};

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as InboundBody | null;
  if (!body?.groupId || !Array.isArray(body?.messages)) {
    return NextResponse.json({ error: "groupId and messages[] required" }, { status: 400 });
  }

  const org = await db.organisation.findFirst({
    where: { whatsappGroupId: body.groupId, whatsappBotEnabled: true },
    select: { id: true, name: true },
  });
  if (!org) {
    return NextResponse.json({ ok: true, ignored: "unknown-or-disabled-group", results: [] });
  }

  const history = (body.history ?? []).map((h) => ({
    authorName: h.authorName,
    body: h.body,
    timestamp: new Date(h.timestamp),
  }));

  const results: ActionForBot[] = [];

  for (const msg of body.messages) {
    try {
      const result = await processOne({
        orgId: org.id,
        orgName: org.name,
        groupId: body.groupId,
        msg,
        history,
      });
      results.push(result);
    } catch (err) {
      console.error("[analyze] processOne failed:", err, "for", msg.waMessageId);
      await recordAnalysis({
        orgId: org.id,
        groupId: body.groupId,
        msg,
        handledBy: "error",
        intent: null,
        action: null,
        confidence: null,
        reasoning: err instanceof Error ? err.message : String(err),
      });
      results.push({
        waMessageId: msg.waMessageId,
        handledBy: "error",
        intent: null,
        react: null,
        reply: null,
      });
    }
  }

  return NextResponse.json({ ok: true, orgId: org.id, results });
}

async function processOne(args: {
  orgId: string;
  orgName: string;
  groupId: string;
  msg: InboundMessage;
  history: { authorName: string | null; body: string; timestamp: Date }[];
}): Promise<ActionForBot> {
  const { orgId, groupId, msg, history } = args;

  // 1. Dedupe by waMessageId.
  const already = await db.analyzedMessage.findUnique({
    where: { waMessageId: msg.waMessageId },
    select: { intent: true, handledBy: true },
  });
  if (already) {
    return {
      waMessageId: msg.waMessageId,
      handledBy: "deduped",
      intent: already.intent,
      react: null,
      reply: null,
    };
  }

  // 2. Skip pathological bodies.
  const body = msg.body.trim();
  if (body.length === 0) {
    await recordAnalysis({
      orgId,
      groupId,
      msg,
      handledBy: "ignored",
      intent: "noise",
      action: null,
      confidence: 1,
      reasoning: "empty body",
    });
    return {
      waMessageId: msg.waMessageId,
      handledBy: "ignored",
      intent: "noise",
      react: null,
      reply: null,
    };
  }

  // 3. Resolve author → User. Accept both "447…" and "+447…" forms —
  //    the bot hands them in without the `+`, but stored numbers are
  //    E.164 with `+`.
  const rawPhone = msg.authorPhone.startsWith("+") ? msg.authorPhone : `+${msg.authorPhone}`;
  const normalised = normalisePhone(rawPhone);
  const user = normalised
    ? await db.user.findUnique({
        where: { phoneNumber: normalised },
        select: { id: true, name: true },
      })
    : null;

  // Only act on attendance for users who ARE members of this org (and
  // haven't been marked as left). Unknown users → we still let Claude
  // classify the message so we can maybe answer a question, but we
  // won't register attendance on their behalf.
  const membership = user
    ? await db.membership.findUnique({
        where: { userId_orgId: { userId: user.id, orgId } },
        select: { leftAt: true },
      })
    : null;
  const isActiveMember = !!membership && membership.leftAt === null;

  // 4. Ask Claude.
  const verdict = await analyzeMessage({
    groupId,
    message: {
      body,
      authorPhone: msg.authorPhone,
      authorName: msg.authorName,
      authorUserId: user?.id ?? null,
      waMessageId: msg.waMessageId,
      timestamp: new Date(msg.timestamp),
    },
    history,
  });

  // 5. Execute the verdict.
  const { react, reply } = await executeVerdict({
    verdict,
    user: user && isActiveMember ? { id: user.id, name: user.name } : null,
    orgName: args.orgName,
  });

  // 6. Record the outcome for dedupe + audit.
  await recordAnalysis({
    orgId,
    groupId,
    msg,
    handledBy: "llm",
    intent: verdict.intent,
    action: verdict.registerAttendance ?? (react || reply ? "react-or-reply" : "none"),
    confidence: verdict.confidence,
    reasoning: verdict.reasoning,
    authorUserId: user?.id ?? null,
  });

  return {
    waMessageId: msg.waMessageId,
    handledBy: "llm",
    intent: verdict.intent,
    react,
    reply,
    reasoning: verdict.reasoning,
  };
}

async function executeVerdict(args: {
  verdict: AnalysisResult;
  user: { id: string; name: string | null } | null;
  orgName: string;
}): Promise<{ react: string | null; reply: string | null }> {
  const { verdict, user } = args;
  let reply = verdict.reply;

  // Attendance side-effects only run for a known active member — we
  // never change a phone's attendance without an established membership.
  if (verdict.registerAttendance && user) {
    const matchForOrg = await db.match.findFirst({
      where: {
        activity: { org: { memberships: { some: { userId: user.id } } } },
        status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
        attendanceDeadline: { gt: new Date() },
      },
      orderBy: { date: "asc" },
    });
    if (matchForOrg) {
      try {
        if (verdict.registerAttendance === "IN") {
          await registerAttendance(user.id, matchForOrg.id);
        } else {
          await cancelAttendance(user.id, matchForOrg.id);
        }
      } catch (err) {
        console.error("[analyze] attendance update failed:", err);
      }

      // Personalise replacement-request replies if Claude didn't
      // include the player's name in its reply.
      if (verdict.intent === "replacement_request" && reply && user.name && !reply.includes(user.name)) {
        reply = reply.replace(/<name>/gi, user.name);
      }
    }
  }

  return { react: verdict.react, reply };
}

async function recordAnalysis(args: {
  orgId: string;
  groupId: string;
  msg: InboundMessage;
  handledBy: string;
  intent: string | null;
  action: string | null;
  confidence: number | null;
  reasoning: string;
  authorUserId?: string | null;
}) {
  try {
    await db.analyzedMessage.create({
      data: {
        waMessageId: args.msg.waMessageId,
        orgId: args.orgId,
        groupId: args.groupId,
        authorPhone: args.msg.authorPhone,
        authorUserId: args.authorUserId ?? null,
        body: args.msg.body.slice(0, 2000),
        handledBy: args.handledBy,
        intent: args.intent,
        action: args.action,
        confidence: args.confidence,
        reasoning: args.reasoning.slice(0, 2000),
      },
    });
  } catch (err) {
    // Unique violation → already analysed in a concurrent request; fine.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/unique/i.test(msg)) {
      console.error("[analyze] recordAnalysis failed:", err);
    }
  }
}
