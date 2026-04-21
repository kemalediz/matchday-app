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
import { computeEloDeltas } from "@/lib/elo";

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
        orgId: org.id,
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

/**
 * Slot → emoji map for the bot's attendance reactions. Confirmed slots
 * 1-10 get the corresponding keycap; 11+ fall back to ⚽ (WhatsApp
 * reactions don't support multi-digit keycaps). Bench slots always get
 * 🪑. OUT always gets 👋.
 */
const KEYCAP: Record<number, string> = {
  1: "1️⃣",
  2: "2️⃣",
  3: "3️⃣",
  4: "4️⃣",
  5: "5️⃣",
  6: "6️⃣",
  7: "7️⃣",
  8: "8️⃣",
  9: "9️⃣",
  10: "🔟",
};

async function executeVerdict(args: {
  verdict: AnalysisVerdict;
  user: { id: string; name: string | null } | null;
  orgId: string;
}): Promise<{ react: string | null; reply: string | null }> {
  const { verdict, user, orgId } = args;
  let finalReact = verdict.react;
  const finalReply = verdict.reply;

  // ── Attendance IN/OUT ────────────────────────────────────────────
  //    When the verdict says to register, update attendance and then
  //    compute the real slot emoji so the bot reacts with the correct
  //    1️⃣–🔟 / 🪑 / 👋 instead of the generic 👍/👋 Claude emits.
  if (verdict.registerAttendance && user) {
    const matchForOrg = await db.match.findFirst({
      where: {
        activity: { orgId },
        status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
        attendanceDeadline: { gt: new Date() },
      },
      orderBy: { date: "asc" },
    });
    if (matchForOrg) {
      try {
        if (verdict.registerAttendance === "IN") {
          const result = await registerAttendance(user.id, matchForOrg.id);
          // `registerAttendance` returns { status, position } but position
          // is the raw 1-based index of the insertion. Re-derive the slot
          // within the bucket so the emoji matches what the player sees
          // on the list (nth confirmed / nth bench).
          const attendances = await db.attendance.findMany({
            where: { matchId: matchForOrg.id, status: { in: ["CONFIRMED", "BENCH"] } },
            orderBy: { position: "asc" },
          });
          const confirmed = attendances.filter((a) => a.status === "CONFIRMED");
          const bench = attendances.filter((a) => a.status === "BENCH");
          if (result.status === "CONFIRMED") {
            const slot = confirmed.findIndex((a) => a.userId === user.id) + 1;
            finalReact = KEYCAP[slot] ?? "⚽";
          } else {
            // BENCH
            const slot = bench.findIndex((a) => a.userId === user.id) + 1;
            finalReact = slot > 0 ? "🪑" : "🪑";
          }
        } else {
          await cancelAttendance(user.id, matchForOrg.id);
          finalReact = "👋";
        }
      } catch (err) {
        console.error("[analyze] attendance update failed:", err);
      }
    }
  }

  // ── Score submission ─────────────────────────────────────────────
  //    LLM extracted scoreRed / scoreYellow. Match is identified the
  //    same way /api/whatsapp/score does: most recent ended-but-unscored
  //    match in the org. Authoriser check: confirmed participant OR
  //    org admin (same as the existing score endpoint).
  if (
    verdict.intent === "score" &&
    typeof verdict.scoreRed === "number" &&
    typeof verdict.scoreYellow === "number"
  ) {
    try {
      const now = new Date();
      const candidates = await db.match.findMany({
        where: {
          activity: { orgId },
          redScore: null,
          yellowScore: null,
          status: { in: ["TEAMS_PUBLISHED", "COMPLETED", "TEAMS_GENERATED"] },
        },
        include: {
          activity: true,
          teamAssignments: {
            include: { user: { select: { matchRating: true } } },
          },
        },
        orderBy: { date: "desc" },
        take: 10,
      });
      const target = candidates.find((m) => {
        const endedAt = new Date(m.date.getTime() + m.activity.matchDurationMins * 60 * 1000);
        return endedAt <= now;
      });
      if (target && user) {
        const attendance = await db.attendance.findUnique({
          where: { matchId_userId: { matchId: target.id, userId: user.id } },
        });
        const membership = await db.membership.findUnique({
          where: { userId_orgId: { userId: user.id, orgId } },
        });
        const isAdmin =
          membership && (membership.role === "OWNER" || membership.role === "ADMIN");
        const wasPlaying = attendance?.status === "CONFIRMED";
        if (isAdmin || wasPlaying) {
          await db.match.update({
            where: { id: target.id },
            data: {
              redScore: verdict.scoreRed,
              yellowScore: verdict.scoreYellow,
              status: "COMPLETED",
            },
          });
          try {
            const eloInputs = target.teamAssignments.map((t) => ({
              userId: t.userId,
              team: t.team,
              matchRating: t.user.matchRating,
            }));
            const deltas = computeEloDeltas(eloInputs, verdict.scoreRed, verdict.scoreYellow);
            await db.$transaction(
              deltas.map((d) =>
                db.user.update({ where: { id: d.userId }, data: { matchRating: d.after } }),
              ),
            );
          } catch (err) {
            console.error("[analyze] Elo update after LLM score failed:", err);
          }
          finalReact = finalReact ?? "👍";
        } else {
          // Non-participant / non-admin tried to record a score — stay
          // silent. Don't even react; the LLM reasoning gets logged.
          finalReact = null;
        }
      }
    } catch (err) {
      console.error("[analyze] score processing failed:", err);
    }
  }

  return { react: finalReact, reply: finalReply };
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
