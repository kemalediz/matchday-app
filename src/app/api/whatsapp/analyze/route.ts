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
import { generateTeamsForMatch } from "@/lib/team-generation";

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

  // 3b. Backfill slot-emoji on earlier duplicate IN messages from same author.
  //     State-collapse: when a player sends "count me in" then "IN" 30s later,
  //     the LLM only registers the latest (correct — no double-registration).
  //     But the earlier message gets a plain 👍 which looks like "not registered"
  //     and confuses people into retyping. If a later verdict for the same
  //     author registered them as IN with a keycap slot emoji, propagate that
  //     emoji back to the earlier intent=in verdicts so the chat reads cleanly.
  const keycapSet = new Set(Object.values(KEYCAP).concat(["🪑"]));
  const latestInReactByUser = new Map<string, string>();
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const uid = senderById.get(r.waMessageId)?.userId;
    if (!uid || r.intent !== "in" || !r.react) continue;
    if (keycapSet.has(r.react)) latestInReactByUser.set(uid, r.react);
  }
  for (const r of results) {
    const uid = senderById.get(r.waMessageId)?.userId;
    if (!uid || r.intent !== "in" || !r.react) continue;
    if (keycapSet.has(r.react)) continue;
    const slot = latestInReactByUser.get(uid);
    if (slot) r.react = slot;
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
  if (msg.authorName && msg.authorName.trim().length >= 2) {
    // Fuzzy name match — the sender's WhatsApp display name ("Kemal
    // Ediz") often doesn't exactly match the DB record ("Kemal"), so
    // we:
    //   1. First try exact case-insensitive equals (the historic rule)
    //   2. Fall back to first-token match on either side — DB first
    //      name vs pushname first name, either direction
    // Both variants still require a UNIQUE match in the org to avoid
    // guessing between two players with the same first name.
    const pushname = msg.authorName.trim();
    const candidates = await db.membership.findMany({
      where: { orgId, leftAt: null },
      include: { user: { select: { id: true, name: true } } },
    });
    const norm = (s: string) =>
      s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const pushTokens = norm(pushname).split(/\s+/).filter(Boolean);
    const pushFirst = pushTokens[0] ?? "";

    const equalsMatches = candidates.filter(
      (c) => c.user.name && norm(c.user.name) === norm(pushname),
    );
    if (equalsMatches.length === 1) {
      return {
        userId: equalsMatches[0].user.id,
        name: equalsMatches[0].user.name,
        phone: null,
      };
    }

    const firstNameMatches = candidates.filter((c) => {
      if (!c.user.name) return false;
      const dbTokens = norm(c.user.name).split(/\s+/).filter(Boolean);
      const dbFirst = dbTokens[0] ?? "";
      return (
        dbFirst === pushFirst ||
        (dbFirst.length >= 3 && pushFirst.length >= 3 &&
          (dbFirst.startsWith(pushFirst) || pushFirst.startsWith(dbFirst)))
      );
    });
    if (firstNameMatches.length === 1) {
      return {
        userId: firstNameMatches[0].user.id,
        name: firstNameMatches[0].user.name,
        phone: null,
      };
    }
  }
  // Auto-create a provisional member when we couldn't match.
  //   Rationale: the message came from the org's monitored WhatsApp
  //   group, so by construction the sender is in the roster. Silently
  //   dropping their IN/OUT is a worse failure mode than occasionally
  //   creating a duplicate that an admin has to merge. Admin dashboard
  //   surfaces provisional members (via Membership.provisionallyAddedAt)
  //   so they can set phone/position/rating or remove them.
  const provisional = await createProvisionalMember(orgId, msg);
  if (provisional) return provisional;
  return { userId: null, name: msg.authorName, phone: null };
}

async function createProvisionalMember(
  orgId: string,
  msg: InboundMessage,
): Promise<ResolvedSender | null> {
  const name = msg.authorName?.trim();
  if (!name || name.length < 2) return null;
  // Skip obvious non-player authors (bot itself, group admin system messages).
  const blocked = /^(match time|matchtime|whatsapp|system)$/i;
  if (blocked.test(name)) return null;

  const normPhone = msg.authorPhone
    ? normalisePhone(msg.authorPhone.startsWith("+") ? msg.authorPhone : `+${msg.authorPhone}`)
    : null;

  // Synthetic email keeps the User.email unique constraint happy — users
  // can claim their account later via a real email address when they
  // log in (onboarding flow overwrites this placeholder).
  const emailSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "player";
  const syntheticEmail = `provisional+${emailSlug}-${Date.now().toString(36)}@matchtime.local`;

  try {
    // Phone is unique globally, so if a user with that phone already
    // exists (from another org), reuse them rather than failing.
    let user = normPhone
      ? await db.user.findUnique({ where: { phoneNumber: normPhone } })
      : null;
    if (!user) {
      user = await db.user.create({
        data: {
          name,
          email: syntheticEmail,
          phoneNumber: normPhone,
          onboarded: false,
          isActive: true,
        },
      });
    }

    // Upsert membership: if user already exists in this org (e.g. re-joined),
    // just clear leftAt and mark as provisional again.
    await db.membership.upsert({
      where: { userId_orgId: { userId: user.id, orgId } },
      create: {
        userId: user.id,
        orgId,
        role: "PLAYER",
        provisionallyAddedAt: new Date(),
      },
      update: {
        leftAt: null,
        provisionallyAddedAt: new Date(),
      },
    });
    console.log(`[analyze] auto-created provisional member ${user.id} (${name}) in org ${orgId}`);
    return { userId: user.id, name: user.name, phone: normPhone };
  } catch (err) {
    console.error("[analyze] provisional member creation failed:", err);
    return null;
  }
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
  let finalReply = verdict.reply;

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
  //    LLM extracted scoreRed / scoreYellow. We record the score as
  //    long as we can identify an unscored match that has actually
  //    ended. If we can resolve the sender to a known org admin or
  //    confirmed participant → write the score. If we CAN'T resolve
  //    them (e.g. WhatsApp hid the phone via @lid and the pushname
  //    didn't match any player) → still write the score, because the
  //    message came from the monitored org's group chat and losing
  //    the score entirely is a worse failure mode than occasionally
  //    trusting a wrong number. Admin can correct via the dashboard.
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
      if (target) {
        // Authorisation check only blocks if we resolved a user AND they
        // are neither admin nor confirmed. If user is null (unresolvable
        // @lid), we permit.
        let allowed = true;
        if (user) {
          const attendance = await db.attendance.findUnique({
            where: { matchId_userId: { matchId: target.id, userId: user.id } },
          });
          const membership = await db.membership.findUnique({
            where: { userId_orgId: { userId: user.id, orgId } },
          });
          const isAdmin =
            membership && (membership.role === "OWNER" || membership.role === "ADMIN");
          const wasPlaying = attendance?.status === "CONFIRMED";
          allowed = !!(isAdmin || wasPlaying);
        }
        if (allowed) {
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
          // Resolved sender who is neither admin nor confirmed tried to
          // record — silent. Don't even react.
          finalReact = null;
        }
      }
    } catch (err) {
      console.error("[analyze] score processing failed:", err);
    }
  }

  // ── Generate-teams request ───────────────────────────────────────
  //    Someone asked the bot to balance + post the teams. Optionally
  //    with "consider Ibrahim + Ehtisham as IN" overrides, which we
  //    honour by flipping those players from DROPPED/BENCH to
  //    CONFIRMED before calling the balancer. Server generates the
  //    reply text from the actual balancer output — Claude's `reply`
  //    field (if any) is overridden.
  if (verdict.intent === "generate_teams_request") {
    try {
      const match = await db.match.findFirst({
        where: {
          activity: { orgId },
          status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
          attendanceDeadline: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
        orderBy: { date: "asc" },
      });
      if (!match) {
        finalReply = "No match lined up to build teams for.";
        finalReact = "🤔";
      } else {
        // Force-include players named in the message.
        const includedLog: string[] = [];
        const unmatchedLog: string[] = [];
        if (verdict.includeNames && verdict.includeNames.length > 0) {
          const roster = await db.attendance.findMany({
            where: { matchId: match.id },
            include: { user: { select: { id: true, name: true } } },
          });
          const norm = (s: string) =>
            s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
          for (const rawName of verdict.includeNames) {
            const target = roster.find((a) => {
              if (!a.user.name) return false;
              const u = norm(a.user.name);
              const q = norm(rawName);
              return u === q || u.startsWith(`${q} `) || u.split(" ")[0] === q;
            });
            if (!target) {
              unmatchedLog.push(rawName);
              continue;
            }
            if (target.status !== "CONFIRMED") {
              await db.attendance.update({
                where: { id: target.id },
                data: { status: "CONFIRMED" },
              });
            }
            includedLog.push(target.user.name ?? rawName);
          }
        }

        const result = await generateTeamsForMatch(match.id);
        if (result.ok) {
          let text = result.groupPost;
          if (includedLog.length > 0) {
            text = `_Including ${includedLog.join(", ")} as CONFIRMED per the request._\n\n${text}`;
          }
          if (unmatchedLog.length > 0) {
            text += `\n\n_(couldn't find ${unmatchedLog.join(", ")} in the roster — ignored)_`;
          }
          finalReply = text;
          finalReact = "⚽";
        } else {
          finalReply = `Can't build teams right now — ${result.reason}.`;
          finalReact = "🤔";
        }
      }
    } catch (err) {
      console.error("[analyze] generate_teams_request failed:", err);
      finalReply = null;
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
