/**
 * Smart-analysis entry point. Called by the bot once per flush cycle
 * (every ~10 min, or immediately on urgency). Accepts a batch of group
 * messages that the regex fast-path didn't handle, runs Claude Haiku
 * ONCE on the batch, executes verdicts, and returns per-message
 * actions for the bot to perform on the WhatsApp side.
 *
 * Flow:
 *   1. Dedupe: skip any waMessageId already in AnalyzedMessage
 *      (covers bot restarts + retries).
 *   2. Hand the batch + cached context to `analyzeBatch()` (one Claude call).
 *   3. For each verdict:
 *        a. Resolve author → User (phone, then fallback by pushname).
 *        b. If verdict says register IN/OUT and we have a User, update
 *           attendance via lib/attendance.ts.
 *        c. Record the outcome in AnalyzedMessage (intent, confidence,
 *           action, reasoning).
 *   4. Return the bot the per-message actions (react, reply) + the
 *      next-kickoff timestamp it needs to decide urgency.
 *
 * Request:
 *   {
 *     groupId: "xxx@g.us",
 *     history: [{authorName, body, timestamp}],
 *     messages: [{waMessageId, body, authorPhone, authorName, timestamp}]
 *   }
 *
 * Response:
 *   {
 *     ok: true,
 *     orgId: "...",
 *     nextKickoffMs: number | null,   // ms since epoch of the next match,
 *                                     // so the bot knows when to urgency-
 *                                     // flush without an extra round trip
 *     results: [
 *       { waMessageId, handledBy, intent, react, reply, reasoning? }
 *     ]
 *   }
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { normalisePhone } from "@/lib/phone";
import {
  analyzeBatch,
  type AnalysisVerdict,
  type BatchInputMessage,
} from "@/lib/message-analyzer";
import { registerAttendance, cancelAttendance } from "@/lib/attendance";

interface InboundMessage {
  waMessageId: string;
  body: string;
  authorPhone: string;
  authorName: string | null;
  timestamp: string;
}

interface InboundHistory {
  authorName: string | null;
  body: string;
  timestamp: string;
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

type ResolvedSender = {
  userId: string | null;
  name: string | null;
  phone: string | null;
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

  // 1. Dedupe.
  const all = body.messages;
  const ids = all.map((m) => m.waMessageId);
  const seen = await db.analyzedMessage.findMany({
    where: { waMessageId: { in: ids } },
    select: { waMessageId: true, intent: true, handledBy: true },
  });
  const seenMap = new Map(seen.map((s) => [s.waMessageId, s]));

  const fresh: InboundMessage[] = [];
  const results: ActionForBot[] = [];

  for (const msg of all) {
    const prior = seenMap.get(msg.waMessageId);
    if (prior) {
      results.push({
        waMessageId: msg.waMessageId,
        handledBy: "deduped",
        intent: prior.intent,
        react: null,
        reply: null,
      });
      continue;
    }
    const trimmed = msg.body.trim();
    if (trimmed.length === 0) {
      await recordAnalysis({
        orgId: org.id,
        groupId: body.groupId,
        msg,
        handledBy: "ignored",
        intent: "noise",
        action: null,
        confidence: 1,
        reasoning: "empty body",
      });
      results.push({
        waMessageId: msg.waMessageId,
        handledBy: "ignored",
        intent: "noise",
        react: null,
        reply: null,
      });
      continue;
    }
    fresh.push(msg);
  }

  // 2. Resolve senders + hand the whole fresh batch to Claude in one call.
  const senderById = new Map<string, ResolvedSender>();
  for (const m of fresh) {
    senderById.set(m.waMessageId, await resolveSender(org.id, m));
  }

  const history = (body.history ?? []).map((h) => ({
    authorName: h.authorName,
    body: h.body,
    timestamp: new Date(h.timestamp),
  }));

  const batchInputs: BatchInputMessage[] = fresh.map((m) => {
    const s = senderById.get(m.waMessageId)!;
    return {
      waMessageId: m.waMessageId,
      body: m.body,
      authorPhone: m.authorPhone,
      authorName: m.authorName,
      authorUserId: s.userId,
      timestamp: new Date(m.timestamp),
    };
  });

  const verdicts = fresh.length
    ? await analyzeBatch({ groupId: body.groupId, history, messages: batchInputs })
    : [];

  // 3. Execute verdicts sequentially (attendance writes are cheap and
  //    order matters for state-collapse correctness).
  for (let i = 0; i < fresh.length; i++) {
    const msg = fresh[i];
    const verdict = verdicts[i];
    const sender = senderById.get(msg.waMessageId)!;
    try {
      const { react, reply } = await executeVerdict({
        verdict,
        user: sender.userId ? { id: sender.userId, name: sender.name } : null,
      });
      await recordAnalysis({
        orgId: org.id,
        groupId: body.groupId,
        msg,
        handledBy: "llm",
        intent: verdict.intent,
        action:
          verdict.registerAttendance ??
          (react || reply ? (react ? "react" : "reply") : "none"),
        confidence: verdict.confidence,
        reasoning: verdict.reasoning,
        authorUserId: sender.userId,
      });
      results.push({
        waMessageId: msg.waMessageId,
        handledBy: "llm",
        intent: verdict.intent,
        react,
        reply,
        reasoning: verdict.reasoning,
      });
    } catch (err) {
      console.error("[analyze] verdict execution failed:", err, "for", msg.waMessageId);
      await recordAnalysis({
        orgId: org.id,
        groupId: body.groupId,
        msg,
        handledBy: "error",
        intent: verdict.intent,
        action: null,
        confidence: verdict.confidence,
        reasoning: err instanceof Error ? err.message : String(err),
      });
      results.push({
        waMessageId: msg.waMessageId,
        handledBy: "error",
        intent: verdict.intent,
        react: null,
        reply: null,
      });
    }
  }

  // 4. Return + include next-kickoff so the bot can urgency-flush.
  const nextMatch = await db.match.findFirst({
    where: {
      activity: { orgId: org.id },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
    },
    orderBy: { date: "asc" },
    select: { date: true },
  });

  return NextResponse.json({
    ok: true,
    orgId: org.id,
    nextKickoffMs: nextMatch?.date.getTime() ?? null,
    results,
  });
}

async function resolveSender(orgId: string, msg: InboundMessage): Promise<ResolvedSender> {
  // Phone first (most accurate). Accept raw digits — prepend '+' if the
  // bot didn't. @lid senders arrive with empty phone: that's the signal
  // to try a name-based fallback.
  if (msg.authorPhone) {
    const raw = msg.authorPhone.startsWith("+") ? msg.authorPhone : `+${msg.authorPhone}`;
    const norm = normalisePhone(raw);
    if (norm) {
      const user = await db.user.findUnique({
        where: { phoneNumber: norm },
        select: { id: true, name: true },
      });
      if (user) return { userId: user.id, name: user.name, phone: norm };
    }
  }
  if (msg.authorName && msg.authorName.trim().length >= 3) {
    const matches = await db.membership.findMany({
      where: {
        orgId,
        leftAt: null,
        user: {
          name: { equals: msg.authorName.trim(), mode: "insensitive" },
        },
      },
      include: { user: { select: { id: true, name: true } } },
      take: 2,
    });
    if (matches.length === 1) {
      return { userId: matches[0].user.id, name: matches[0].user.name, phone: null };
    }
  }
  return { userId: null, name: msg.authorName, phone: null };
}

async function executeVerdict(args: {
  verdict: AnalysisVerdict;
  user: { id: string; name: string | null } | null;
}): Promise<{ react: string | null; reply: string | null }> {
  const { verdict, user } = args;

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
    }
  }

  return { react: verdict.react, reply: verdict.reply };
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
        authorPhone: args.msg.authorPhone || null,
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
    const m = err instanceof Error ? err.message : String(err);
    if (!/unique/i.test(m)) {
      console.error("[analyze] recordAnalysis failed:", err);
    }
  }
}
