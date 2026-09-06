/**
 * Smart-analysis entry point. Called by the bot once per flush cycle
 * (every ~10 min, or immediately on urgency). Accepts a batch of EVERY
 * message the group posted in that window — the bot has had no regex
 * pre-filter since 2026-04-21 — decides each one, and returns
 * per-message actions for the bot to perform on the WhatsApp side.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THIS FILE STOPPED CALLING ONE BIG PROMPT ON 2026-09-06 (§10 step 8)
 * ─────────────────────────────────────────────────────────────────────
 *
 * Until this change the middle of this function was a single
 * `analyzeBatch()` call — one 19,850-token `SYSTEM_PROMPT` asked to
 * understand English, decide what the database should say, do
 * arithmetic and write the group's public message, all at once — plus
 * roughly 1,200 lines correcting what came back. §5 counted fifty-four
 * distinct guards over that output, two of which decided whether to drop
 * a player from a paid match by running regular expressions over the
 * model's English prose.
 *
 * `analyzeBatch` and `SYSTEM_PROMPT` are deleted. What replaced them:
 *
 *   0. DETERMINISTIC PEELS — no model at all. Personal stats link, the
 *      admin stats blast, group→DM Q&A, admin rating progress, help,
 *      the colour swap, the team swap, a bench-prompt answer, a pasted
 *      roster. Each is a database row or a whole-message match, and
 *      each is peeled before the router so nothing else can claim it.
 *   1. ROUTER — `claude-haiku-4-5`, ~360 tokens, nine routes. Banter
 *      exits here and costs nothing further. (`pipeline/gate.ts`)
 *   2. EXTRACTORS — one small specialist per route, strict JSON schema,
 *      returning FACTS about the text only. No intent, no reply, no
 *      reasoning: there is no field in which the model can express a
 *      decision, and no prose for a regex to parse.
 *   3. ENGINES — pure TypeScript. Facts plus squad state decide every
 *      write. One owner per route, asserted below, because two deciders
 *      for one message would mean two replies for one message.
 *   4. COMPOSERS — every number and every name the bot says is read from
 *      the database, after the write landed.
 *
 * A message no owner claims produces SILENCE in the group and one
 * deduped operator DM (`lib/operator-note.ts`). That is the honest cost
 * of the change and §11.5 named it in advance: "the club will experience
 * it as 'the bot got dumber' before they experience it as 'the bot
 * stopped being wrong'."
 *
 * Flow:
 *   1. Dedupe: skip any waMessageId already in AnalyzedMessage
 *      (covers bot restarts + retries).
 *   2. Resolve each author → User (phone, then fallback by pushname).
 *   3. Peel the deterministic paths; route the rest; run each owner.
 *   4. Render one reply and one AnalyzedMessage row per message.
 *   5. Return the bot the per-message actions (react, reply) + the
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
import { signMagicLinkToken, MAGIC_LINK_TTL } from "@/lib/magic-link";
import { buildShortMagicLinkUrl } from "@/lib/short-link";
import { answerScopedQuestion } from "@/lib/dm-qa";
// §10 step 8: `analyzeBatch`, `AnalysisVerdict` and `BatchInputMessage`
// were imported here until this change. They no longer exist.
// `enforceProximity` does, and stays: it rewrites "tonight" → "Tue 8 Sep"
// and the 20:30/21:30 BST-vs-UTC slips, and it is applied to every
// outgoing reply whatever composed it — it was never about the model.
import { enforceProximity } from "@/lib/message-analyzer";
import {
  composeSquadStateReply,
  stripSquadPostMarker,
  SQUAD_POST_MARKER,
  type SquadTruth,
} from "@/lib/group-copy";
import {
  composeOperatorNote,
  OPERATOR_NOTE_MARKER,
  type UnownedMessage,
} from "@/lib/operator-note";
import {
  gateBatch,
  routerIsNeeded,
  GATED_HANDLED_BY,
} from "@/lib/pipeline/gate";
import {
  enabledStepSevenRoutes,
  routesHeaderOverride,
  STEP_SEVEN_HEADER,
} from "@/lib/pipeline/route-flags";
import { runAnswerBatch, ANSWER_HANDLED_BY } from "@/lib/pipeline/answer-batch";
import { runScoreBatch } from "@/lib/score-engine-batch";
import { SCORE_HANDLED_BY } from "@/lib/score-engine";
import { runAdminOpsBatch } from "@/lib/admin-ops-engine-batch";
import { ADMIN_OPS_HANDLED_BY } from "@/lib/admin-ops-engine";
import { runTeamOpsBatch } from "@/lib/team-ops-engine-batch";
import { TEAM_OPS_HANDLED_BY } from "@/lib/team-ops-engine";
import {
  buildScoreApplyDeps,
  buildAdminOpsApplyDeps,
  buildTeamOpsApplyDeps,
} from "@/lib/owner-deps";
import { loadOpenQuestion } from "@/lib/pipeline/load-awaiting-answer";
import { ENGINE_HANDLED_BY } from "@/lib/attendance-engine";
import { describeEngineBatch, runAttendanceEngineBatch } from "@/lib/attendance-engine-batch";
import { resolveBenchConfirmation } from "@/lib/bench-confirmation";
import { getOrgFeatures } from "@/lib/org-features";
// ── SEVENTEEN IMPORTS LEFT THIS FILE WITH THE MEGA-PROMPT (§10 step 8) ─
//
//   Each was the input to, or the correction of, a field on
//   `AnalysisVerdict`. Listed here rather than silently dropped, because
//   "we deleted a guard" and "we deleted a guard whose failure is now
//   unrepresentable" are different claims and only the second one is
//   allowed in this codebase:
//
//     shouldForceSenderOut       the OUT net's regexes over the model's
//                                English prose (`out-safety-net.ts`,
//                                still exported and still tested). §9's
//                                first "no longer possible": one
//                                `polarity` cannot contradict itself and
//                                there is no `reasoning` to parse. The
//                                per-player attribution it could never
//                                have is now one claim per person.
//     looksLikeHypotheticalOrPast  → the facts schema's `tense`
//     offerIsAboutSomeoneElse      → `subject`, a field rather than an
//                                    inference
//     actionRequiresTag            still the policy, applied inside each
//                                    owner (`engine.ts`, `answer-batch`)
//                                    rather than over a verdict here
//     isVagueGuestOfferVerdict     → `personNamed`
//     stripPlaceholderGuests,
//     shouldAskForGuestName,
//     renderGuestNameAsk,
//     guestNameAskKey,
//     GUEST_NAME_ASK_KIND          the whole unnamed-guest ask, moved
//                                    intact: `load-state.ts:183` reads
//                                    the once-per-player dedupe row,
//                                    `engine.ts:470` decides, and
//                                    `compose.ts:298` renders the SAME
//                                    copy from the same module
//     clampRosterDerivedWrites,
//     parsePastedRoster,
//     reconcilePastedRoster,
//     rosterMentions, sameName     → `pasted-roster-registration.ts`,
//                                    peeled above before the router
//     isPromoteFromBenchAuthorized  → `engine.ts`, unchanged in meaning
//     computeEloDeltas,
//     generateTeamsForMatch,
//     formatTeamsPost,
//     londonDateTimeToUtc,
//     formatLondon,
//     recordAttendanceEvent        → the apply layers in
//                                    `owner-deps.ts`, `score-engine.ts`,
//                                    `team-ops-engine.ts`
//     buildBenchUpgradeReply       DEAD, and worth one sentence: it
//                                    rewrote a reply that said "putting
//                                    you on the bench" when the write had
//                                    actually confirmed the player. The
//                                    composer renders from the PROJECTED
//                                    state after the engine decides, so a
//                                    reply cannot describe a write that
//                                    did not happen. The module and its
//                                    tests are kept — they are pure, and
//                                    the rule they encode is still the
//                                    house rule — but nothing calls it.
//     ENGINE_APPLY_DEGRADED_PREFIX  the partial-response net matched it
//                                    as a seventh prose prefix; the note
//                                    now matches ownership.
//     FeatureKey, normaliseName     used only by `executeVerdict`.
import {
  handleOnboardingTurn,
  buildHelpReply,
  parseHelpTopic,
} from "@/lib/onboarding-conversation";
import { registerAttendance, cancelAttendance } from "@/lib/attendance";
import { currentAnalyzeBatchId, withAnalyzeBatch } from "@/lib/analyze-batch-context";
import {
  resolveAttendanceAck,
  attendanceFailureAction,
  attendanceFailureLog,
} from "@/lib/attendance-write-outcome";
import { recordTentative, resolveTentative } from "@/lib/tentative-store";
import { resolveTeamLabels } from "@/lib/team-labels";
import { selectRegistrationMatch } from "@/lib/registration-match-select";
import { messageTagsBot } from "@/lib/interaction-contract";
import { mergeRecruitReply } from "@/lib/recruit-request";
import { readBenchPromptAnswer } from "@/lib/bench-prompt-answer";
import { decidePastedRosterRegistration } from "@/lib/pasted-roster-registration";

interface InboundMessage {
  waMessageId: string;
  body: string;
  authorPhone: string;
  authorName: string | null;
  timestamp: string;
  /** Raw WhatsApp mention JIDs (e.g. "447700900123@c.us", "…@lid"),
   *  forwarded UNCHANGED for the onboarding admin parser. */
  mentions?: string[];
  /** Did this message @-mention the bot's own JID? Computed on the Pi
   *  (only it knows the bot's selfId) and forwarded as a structured
   *  signal. PRIMARY input to the @Match Time interaction-contract gate;
   *  `undefined` from older Pi builds falls back to body text matching. */
  botMentioned?: boolean;
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
  /** Optional stored chat history for the onboarding ENRICHMENT pass.
   *  DISTINCT from `history` above: that field is the LLM-context history
   *  the main analyzer consumes ({authorName, body, timestamp}). This one
   *  is the {author, authorPhone?, text, timestamp} shape consumed by
   *  runOnboardingEnrichment via handleOnboardingTurn. Named separately
   *  to avoid clobbering the existing `history` field; forwarded only to
   *  the onboarding turn. Absent → no enrichment, behaviour unchanged. */
  enrichmentHistory?: Array<{
    author: string;
    authorPhone?: string | null;
    text: string;
    timestamp: string | number;
  }>;
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

/**
 * One HTTP request = one analyze BATCH = one `batchId`.
 *
 * The Pi flushes a WINDOW of buffered messages here and the route
 * reasons over all of it at once, so the batch is the unit any replay
 * of this history has to reconstruct. Stamping it (via
 * `lib/analyze-batch-context.ts`, read in `recordAnalysis`) replaces
 * the timing heuristic `e2e/replay/reconstruct.ts` had to use, which
 * threw away 62 batches whose write gaps were genuinely ambiguous.
 * Purely additive: the column is nullable and nothing branches on it.
 */
export async function POST(request: Request) {
  return withAnalyzeBatch(() => handleAnalyzeRequest(request));
}

async function handleAnalyzeRequest(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as InboundBody | null;
  if (!body?.groupId || !Array.isArray(body?.messages)) {
    return NextResponse.json({ error: "groupId and messages[] required" }, { status: 400 });
  }

  // ── Phase 2: autonomous onboarding ───────────────────────────────
  //   Runs BEFORE the bot-enabled-org gate. A group with no org is
  //   normally ignored; here it can bootstrap itself via an explicit
  //   "@MatchTime setup" trigger, then a multi-turn in-group Q&A.
  //   While a session is active every batch routes here (not the
  //   normal analyzer) until it completes/abandons.
  {
    const onb = await handleOnboardingIfApplicable(body);
    if (onb) return NextResponse.json(onb);
  }

  const org = await db.organisation.findFirst({
    where: { whatsappGroupId: body.groupId, whatsappBotEnabled: true },
    select: { id: true, name: true },
  });
  if (!org) {
    return NextResponse.json({ ok: true, ignored: "unknown-or-disabled-group", results: [] });
  }

  // ── Skip the LLM entirely when no message-driven feature is on ───
  //   MoM + player-rating are post-match / poll / scheduler driven —
  //   they never need per-message analysis. Only attendance, bench,
  //   team-balancing, reminders and stats-Q&A read chat. If none of
  //   those are enabled for this org there is nothing for the
  //   analyzer to do, so we return BEFORE the (now Sonnet, ~3×)
  //   LLM call. Takes such a group's analyzer bill to ~£0, which is the
  //   whole claim; the "~£10/mo" it used to say it saved was a
  //   pre-shadow-analyzer, pre-cache-buster guess. See
  //   analyzer-redesign-2026-08-31.md §8.4 for the modelled range and
  //   for why even that is not a measurement. (Onboarding
  //   already returned above when its session is active, so a
  //   mid-setup group still gets handled.)
  //
  //   ALSO: when this org has `featureSquadFromList` on (paste-list
  //   groups like Amir's Thursday — MoM/ratings only, attendance off),
  //   archive each fresh inbound message into GroupMessage so the
  //   squad-extraction cron has data to read. STILL no per-batch LLM
  //   call. The archive write is idempotent on waMessageId (unique).
  {
    const f = await getOrgFeatures(org.id);
    // Squad-from-list orgs ALWAYS archive inbound messages so the
    // squad-extraction cron has raw data to diff — INDEPENDENT of whether
    // the per-batch analyzer also runs below.
    //
    // Regression fix (2026-06-05): this archive used to live inside the
    // `if (!needsAnalyzer)` block. When featureStatsQa was flipped on for
    // every org (commit 3917f00, 29 May), `needsAnalyzer` became always
    // true, so this block stopped running and squad extraction silently
    // broke for squad-from-list groups (Sutton Lads' 4 Jun match
    // registered 0 players → no rating DMs). Archiving must not depend on
    // the analyzer gate.
    //
    // (No inline LLM extraction here — keeps the analyze response fast and
    // never times out. Extraction runs via the daily generate-teams cron
    // backstop plus manual triggers via /api/cron/extract-squads.)
    if (f.squadFromList) {
      await storeMessagesForSquadFromList(org.id, body.groupId, body.messages);
    }
    const needsAnalyzer =
      f.attendance || f.bench || f.teamBalancing || f.reminders || f.statsQa;
    if (!needsAnalyzer) {
      return NextResponse.json({
        ok: true,
        ignored: "no-message-driven-features",
        results: [],
      });
    }
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

  // ── Fast-path: "my stats" / "wrapped" personal-stats request ────────
  //   Deterministic (NO LLM cost — Kemal is cost-conscious about
  //   per-message LLM use). When a resolved sender asks for THEIR OWN
  //   stats, DM them a 48h magic link straight to /profile/stats and
  //   react 📊. Peeled off the batch so the LLM never sees it. Requires
  //   the possessive ("my stats/season/ratings/form/card") or the word
  //   "wrapped" so it never collides with group-level stats questions
  //   ("who's most consistent?") which the LLM still answers from the
  //   Recent History block.
  const STATS_REQUEST = /\bwrapped\b|\bmy\s+(stats|season|ratings?|performance|form|card)\b/i;
  const statsRequestIds = new Set<string>();
  for (const m of fresh) {
    if (!STATS_REQUEST.test(m.body)) continue;
    // Interaction contract: a stats request is an ANSWER-y action MT
    // performs for a player → requires an @Match Time tag. Untagged
    // "my stats" is ordinary chat; stay silent (don't DM, don't peel).
    if (!messageTagsBot(m)) continue;
    const sender = senderById.get(m.waMessageId)!;
    const phone = (sender.phone || m.authorPhone || "").replace(/^\+/, "");
    if (!sender.userId || !phone) continue; // can't DM an unresolved sender
    statsRequestIds.add(m.waMessageId);
    try {
      const token = signMagicLinkToken({
        userId: sender.userId,
        purpose: "sign-in",
        nextPath: "/profile/stats",
        ttlSeconds: MAGIC_LINK_TTL.actionNudge,
      });
      const first = sender.name?.split(" ")[0] ?? "there";
      await db.botJob.create({
        data: {
          orgId: org.id,
          kind: "dm",
          phone,
          text:
            `📊 Hey ${first} — here are your MatchTime stats: ratings over time, your ` +
            `Man-of-the-Match games, how you compare to the squad, your badges, and a ` +
            `shareable season card.\n\n${await buildShortMagicLinkUrl(token)}\n\nLink works for 48h.`,
        },
      });
    } catch (err) {
      console.error("[analyze] my-stats DM queue failed:", err);
    }
    await recordAnalysis({
      orgId: org.id,
      groupId: body.groupId,
      msg: m,
      handledBy: "fast-path",
      intent: "stats_link",
      action: "dm-stats-link",
      confidence: 1,
      reasoning: "personal stats request — DM'd a magic link to /profile/stats",
      authorUserId: sender.userId,
      authorName: m.authorName ?? null,
    });
    results.push({
      waMessageId: m.waMessageId,
      handledBy: "fast-path",
      intent: "stats_link",
      react: "📊",
      reply: null,
    });
  }
  // ── Fast-path: admin "DM stats/ratings to active players" ──────────
  //   An ADMIN asking the bot to push everyone their personal stats
  //   link ("@MatchTime DM ratings of active players", "send everyone
  //   their stats"). Each active member with a phone gets a DM with
  //   their OWN never-expiring magic link to /profile/stats. Gated to
  //   OWNER/ADMIN so randoms can't trigger a DM blast. No LLM cost.
  const blastTrigger = (text: string) =>
    /\b(dm|send|share|message)\b/i.test(text) &&
    /\b(stats|ratings?)\b/i.test(text) &&
    /\b(everyone|all|active|players|squad|the team|the group)\b/i.test(text);
  for (const m of fresh) {
    if (statsRequestIds.has(m.waMessageId)) continue; // already handled as personal
    if (!blastTrigger(m.body)) continue;
    const sender = senderById.get(m.waMessageId)!;
    statsRequestIds.add(m.waMessageId); // peel off the LLM batch regardless
    // Admin gate.
    let isAdmin = false;
    if (sender.userId) {
      const mem = await db.membership.findUnique({
        where: { userId_orgId: { userId: sender.userId, orgId: org.id } },
        select: { role: true },
      });
      isAdmin = mem?.role === "OWNER" || mem?.role === "ADMIN";
    }
    if (!isAdmin) {
      results.push({
        waMessageId: m.waMessageId,
        handledBy: "fast-path",
        intent: "stats_blast_denied",
        react: "🔒",
        reply: null,
      });
      await recordAnalysis({
        orgId: org.id, groupId: body.groupId, msg: m,
        handledBy: "fast-path", intent: "stats_blast_denied", action: null,
        confidence: 1, reasoning: "non-admin asked to DM stats to everyone — ignored",
        authorUserId: sender.userId, authorName: m.authorName ?? null,
      });
      continue;
    }
    // Queue a personal stats DM for every active member with a phone.
    const members = await db.membership.findMany({
      where: { orgId: org.id, leftAt: null, user: { phoneNumber: { not: null } } },
      select: { user: { select: { id: true, name: true, phoneNumber: true } } },
    });
    let queued = 0;
    for (const mem of members) {
      const u = mem.user;
      if (!u.phoneNumber) continue;
      try {
        const token = signMagicLinkToken({
          userId: u.id,
          purpose: "sign-in",
          nextPath: "/profile/stats",
          ttlSeconds: MAGIC_LINK_TTL.bookmark,
        });
        const first = u.name?.split(" ")[0] ?? "there";
        await db.botJob.create({
          data: {
            orgId: org.id,
            kind: "dm",
            phone: u.phoneNumber.replace(/^\+/, ""),
            text:
              `📊 Hi ${first} — here are your MatchTime stats: your ratings over time, ` +
              `Man-of-the-Match games, how you stack up against the squad, your badges and a ` +
              `shareable season card.\n\n${await buildShortMagicLinkUrl(token)}\n\nKeep this link — it doesn't expire.`,
          },
        });
        queued++;
      } catch (err) {
        console.error(`[analyze] stats-blast DM failed for ${u.id}:`, err);
      }
    }
    await recordAnalysis({
      orgId: org.id, groupId: body.groupId, msg: m,
      handledBy: "fast-path", intent: "stats_blast", action: `dm-stats-blast:${queued}`,
      confidence: 1, reasoning: `admin stats blast — queued ${queued} personal stats-link DMs`,
      authorUserId: sender.userId, authorName: m.authorName ?? null,
    });
    results.push({
      waMessageId: m.waMessageId,
      handledBy: "fast-path",
      intent: "stats_blast",
      react: "✅",
      reply: `📊 Done — DM'd ${queued} player${queued === 1 ? "" : "s"} their personal stats link. They'll arrive over the next few minutes.`,
    });
  }

  // ── Group → DM: "@MT DM me <question>" ──────────────────────────────
  //   When someone in the group explicitly asks to be DM'd an answer
  //   ("dm me the fixtures", "@Match Time message me when's the next
  //   game"), answer them PRIVATELY via the scoped Q&A engine instead
  //   of cluttering the group. Same no-leak guardrails as direct DMs
  //   (dm-qa.ts: only group-public + the asker's own data). React 📩 in
  //   the group so it's clear it was handled. Personal stats requests
  //   are already handled above (they DM a stats link), so skip those.
  const DM_ME = /\b(dm|pm|message)\s+me\b/i;
  for (const m of fresh) {
    if (statsRequestIds.has(m.waMessageId)) continue;
    if (!DM_ME.test(m.body)) continue;
    // Interaction contract: "DM me <question>" is an answer MT gives →
    // requires an @Match Time tag. Untagged → ordinary chat, stay silent.
    if (!messageTagsBot(m)) continue;
    const sender = senderById.get(m.waMessageId)!;
    const phone = (sender.phone || m.authorPhone || "").replace(/^\+/, "");
    if (!sender.userId || !phone) continue; // can't DM an unresolved sender
    statsRequestIds.add(m.waMessageId); // peel off the LLM batch + drop set
    try {
      const result = await answerScopedQuestion({
        userId: sender.userId,
        orgId: org.id,
        question: m.body,
        askerName: sender.name,
      });
      if (result) {
        await db.botJob.create({
          data: { orgId: org.id, kind: "dm", phone, text: result.answer },
        });
      }
    } catch (err) {
      console.error("[analyze] group→DM Q&A failed:", err);
    }
    await recordAnalysis({
      orgId: org.id, groupId: body.groupId, msg: m,
      handledBy: "fast-path", intent: "dm-qa", action: "dm-scoped-answer",
      confidence: 1, reasoning: "group request to be DM'd — answered privately via scoped Q&A",
      authorUserId: sender.userId, authorName: m.authorName ?? null,
    });
    results.push({
      waMessageId: m.waMessageId,
      handledBy: "fast-path",
      intent: "dm-qa",
      react: "📩",
      reply: null,
    });
  }

  // ── DELETED 2026-09-01: the recruit REGEX fast path ─────────────────
  //   It lived here, matched `looksLikeRecruitRequest(m.body)`, and then
  //   peeled the message off the LLM batch UNCONDITIONALLY. On 2026-09-01
  //   the owner wrote "Najib is out. We need one more player." — the
  //   regex matched the second sentence and the third-party OUT was never
  //   analysed by anything. Najib stayed in, the recruit action saw 10/10,
  //   and MatchTime told the owner his squad was full.
  //
  //   Recruit is now an extracted verdict FACT (`verdict.recruitRequest`,
  //   a flag rather than an intent, because one message carries both a
  //   drop and an ask). It is applied AFTER every attendance write in the
  //   batch, so the blast sees the corrected squad — see "VERDICT-DRIVEN
  //   RECRUIT" further down. The deterministic action and the admin gate
  //   are unchanged; only the classification moved from regex to model.
  //
  //   `looksLikeRecruitRequest` still exists for ONE remaining caller,
  //   api/whatsapp/dm-reply/route.ts — a 1:1 DM surface with no verdict
  //   pipeline. Converting that is the next step, not this PR's.

  // ── Fast-path: admin "how many have rated / who's left / who hasn't
  //    picked MoM?" ────────────────────────────────────────────────────
  //   Grounded rating-completion answer (the analyzer's normal context
  //   has no rating data, so the LLM would otherwise guess). Admin-gated.
  const { looksLikeRatingProgressRequest } = await import("@/lib/rating-progress");
  for (const m of fresh) {
    if (statsRequestIds.has(m.waMessageId)) continue;
    if (!looksLikeRatingProgressRequest(m.body)) continue;
    const sender = senderById.get(m.waMessageId)!;
    statsRequestIds.add(m.waMessageId); // peel off the LLM batch regardless
    let isAdmin = false;
    if (sender.userId) {
      const { isOrgAdmin } = await import("@/lib/org");
      isAdmin = await isOrgAdmin(sender.userId, org.id);
    }
    if (!isAdmin) {
      // Non-admins shouldn't see who-hasn't-rated; stay silent (no react).
      results.push({ waMessageId: m.waMessageId, handledBy: "fast-path", intent: "rating_progress_denied", react: null, reply: null });
      await recordAnalysis({
        orgId: org.id, groupId: body.groupId, msg: m,
        handledBy: "fast-path", intent: "rating_progress_denied", action: null,
        confidence: 1, reasoning: "non-admin asked rating progress — ignored",
        authorUserId: sender.userId, authorName: m.authorName ?? null,
      });
      continue;
    }
    const { loadRatingProgress, formatRatingProgressReply } = await import("@/lib/rating-progress");
    const reply = formatRatingProgressReply(await loadRatingProgress(org.id));
    await recordAnalysis({
      orgId: org.id, groupId: body.groupId, msg: m,
      handledBy: "fast-path", intent: "rating_progress", action: "rating-progress",
      confidence: 1, reasoning: "admin rating-progress query",
      authorUserId: sender.userId, authorName: m.authorName ?? null,
    });
    results.push({ waMessageId: m.waMessageId, handledBy: "fast-path", intent: "rating_progress", react: "📋", reply });
  }

  // ── Fast-path: "@Match Time help [topic]" → usage / topic explainer ─
  //   Tag-gated (honours the interaction contract — only when the bot is
  //   addressed). Feature-aware via the org's live flags. Deterministic;
  //   peeled off the LLM batch so the model never sees it. An OPTIONAL
  //   trailing topic word ("help teams", "help ratings", …) routes into
  //   buildHelpReply for a detailed explainer; bare "help" prints the
  //   topic menu + the how-to block. The regex still REQUIRES the help
  //   keyword and stays single-token-anchored (no mid-sentence "help"
  //   triggers), allowing only an optional topic token after it.
  const HELP_RE =
    /^\s*(?:@?\s*match\s*time|@mt|matchtime)?\s*\bhelp\b(?:\s+[\w &]+?)?\s*$/i;
  for (const m of fresh) {
    if (statsRequestIds.has(m.waMessageId)) continue;
    if (!HELP_RE.test(m.body)) continue;
    if (!messageTagsBot(m)) continue;
    statsRequestIds.add(m.waMessageId); // peel off the LLM batch
    const feats = await getOrgFeatures(org.id);
    const topic = parseHelpTopic(m.body);
    const reply = buildHelpReply(topic, {
      attendance: feats.attendance,
      teamBalancing: feats.teamBalancing,
      momVoting: feats.momVoting,
      playerRating: feats.playerRating,
      statsQa: feats.statsQa,
      reminders: feats.reminders,
      bench: feats.bench,
      paymentTracking: feats.paymentTracking,
    });
    const sender = senderById.get(m.waMessageId)!;
    await recordAnalysis({
      orgId: org.id, groupId: body.groupId, msg: m,
      handledBy: "fast-path", intent: "help", action: "help",
      confidence: 1, reasoning: "usage help requested",
      authorUserId: sender.userId, authorName: m.authorName ?? null,
    });
    results.push({ waMessageId: m.waMessageId, handledBy: "fast-path", intent: "help", react: "👋", reply });
  }

  // Pre-load the ACTIVE registration match. Every attendance WRITE in
  // this request lands on it, every reply is proximity-checked against
  // it, and the four deterministic peels below read it.
  //
  // UNIFIED with findRegistrationMatch (2026-06-18 rollover fix): this
  // MUST be the exact same match every attendance write lands on, picked
  // by the shared pure selector (soonest upcoming, regardless of fullness
  // or attendanceDeadline). Previously this used an attendanceDeadline
  // filter, so once tonight's deadline passed it silently drifted to next
  // week's match — the reply/reconciliation passes then described a
  // different match than the one the write touched.
  const activeMatchForReply = await findRegistrationMatch(org.id);
  const nextMatchForReply = activeMatchForReply
    ? await db.match.findFirst({
        where: { id: activeMatchForReply.id },
        include: {
          attendances: {
            where: { status: "CONFIRMED" },
            include: { user: { select: { name: true } } },
            orderBy: { position: "asc" },
          },
        },
      })
    : null;

  // ═══════════════════════════════════════════════════════════════════
  // §10 STEP 8 — FOUR DETERMINISTIC PEELS, NONE OF WHICH NEEDS A MODEL
  // ═══════════════════════════════════════════════════════════════════
  //
  // Each of these was already deterministic. What made them look like
  // model work was only that they hung off a field the model populated,
  // and deleting the model would have deleted them by accident.
  //
  // They run BEFORE the router, on the raw body and on database rows, so
  // no owner can also claim them and there is exactly one decider per
  // message — the same invariant `claim()` asserts for the owners.
  //
  // Every one requires an `@Match Time` tag except the bench-prompt
  // answer, which is a player answering a direct question MatchTime
  // asked them about their own slot — the purest self-attendance there
  // is, and `interaction-contract.ts` exempts exactly that. Requiring a
  // tag there would mean ignoring the answer to our own question.

  // ── 1 + 2. COLOUR SWAP and TEAM SWAP ───────────────────────────────
  //
  //   Both shipped, both already pure functions of `(orgId, body)`, and
  //   both used to sit INSIDE the per-message loop after the tag gate —
  //   which meant they were reached only when the model's verdict had
  //   survived that far. They are moved up rather than rewritten.
  //
  //   The tag requirement is now EXPLICIT instead of being inherited
  //   from `actionRequiresTag(verdict)`. That is the same policy stated
  //   directly: both team intents are in `ACTIONY_INTENTS`, so an
  //   untagged one was already refused. Measured on 120 days of real
  //   traffic, every colour/team swap in the group carries the tag
  //   ("@Match Time swap the colors and keep the same squad").
  //
  //   Order matters and is preserved from the loop: COLOUR first, so
  //   "swap the colours" can never be read as a player swap.
  for (const m of fresh) {
    if (statsRequestIds.has(m.waMessageId)) continue;
    if (!messageTagsBot(m)) continue;
    const sender = senderById.get(m.waMessageId)!;
    const colourResult = await handleColorSwapIfApplicable(org.id, m.body);
    if (colourResult) {
      statsRequestIds.add(m.waMessageId);
      await recordAnalysis({
        orgId: org.id, groupId: body.groupId, msg: m,
        handledBy: "fast-path", intent: "team_colour_swap", action: "colour-swap",
        confidence: 1, reasoning: colourResult.logReason,
        authorUserId: sender.userId, authorName: m.authorName ?? null,
      });
      results.push({
        waMessageId: m.waMessageId, handledBy: "fast-path",
        intent: "team_colour_swap", react: "✅", reply: colourResult.reply,
      });
      continue;
    }
    // "swap A with B" between two CONFIRMED players is a TEAM swap,
    // never a drop. This guard exists because the mega-prompt had a
    // forceful "swap X with Y = X OUT" rule that wrongly dropped Elvin
    // on 2026-05-19. The prompt is gone, so the rule that misfired is
    // gone — but the FEATURE is not, and it is the reason this stays:
    // "swap Mustafa and Idris" is a team change the group asks for
    // every few weeks (5 in the last 90 days), and it is a `TeamAssignment`
    // move that no attendance extractor models.
    const swapResult = await handleTeamSwapIfApplicable(org.id, m.body);
    if (swapResult) {
      statsRequestIds.add(m.waMessageId);
      await recordAnalysis({
        orgId: org.id, groupId: body.groupId, msg: m,
        handledBy: "fast-path", intent: "team_swap", action: "team-swap",
        confidence: 1, reasoning: swapResult.logReason,
        authorUserId: sender.userId, authorName: m.authorName ?? null,
      });
      results.push({
        waMessageId: m.waMessageId, handledBy: "fast-path",
        intent: "team_swap", react: "✅", reply: swapResult.reply,
      });
    }
  }

  // ── 3. THE BENCH-PROMPT ANSWER ─────────────────────────────────────
  //
  //   A bench player answering MatchTime's own "do you want the slot?"
  //   in the GROUP instead of reacting to the DM. `executeVerdict` used
  //   to reach `resolveBenchConfirmation` through
  //   `verdict.benchConfirmation`, and `attendance-engine-batch.ts:264`
  //   refuses the message for exactly that reason: "a bare 'yes' from
  //   someone with a prompt open stays with the analyzer."
  //
  //   There is no analyzer. But there was never anything to classify
  //   either: the TRIGGER is a `PendingBenchConfirmation` row for this
  //   exact sender, so by the time the text is read the prior is
  //   overwhelming and only a yes/no has to be told apart.
  //   `lib/bench-prompt-answer.ts` does that on a whole-message
  //   allowlist, never a substring, so "no idea what time we're playing"
  //   and "yes but I can only do the first half" both come back null and
  //   fall through to the ordinary pipeline.
  //
  //   ⚠️ ONE SHIPPED BEHAVIOUR IS PRESERVED THAT I WOULD QUESTION IF
  //   THIS WERE NOT A DELETION PR. A bench player who writes "I'm out"
  //   meaning "drop me from the match entirely" is read as DECLINING the
  //   slot, which `resolveBenchConfirmation` treats as a no-op — they
  //   stay on the bench rather than being dropped. That is exactly what
  //   ships today: `route.ts:3186-3190`'s own comment said
  //   "bench-confirmation outranks generic IN/OUT for users on the
  //   open-prompt list". Changing it here would be inventing new product
  //   semantics inside a change that is meant to preserve them, so it is
  //   preserved and flagged instead.
  if (nextMatchForReply) {
    const openPrompts = await db.pendingBenchConfirmation.findMany({
      where: { matchId: nextMatchForReply.id, resolvedAt: null },
      select: { userId: true },
    });
    const prompted = new Set(openPrompts.map((p) => p.userId));
    if (prompted.size > 0) {
      for (const m of fresh) {
        if (statsRequestIds.has(m.waMessageId)) continue;
        const sender = senderById.get(m.waMessageId)!;
        if (!sender.userId || !prompted.has(sender.userId)) continue;
        const answer = readBenchPromptAnswer(m.body);
        if (!answer) continue;
        statsRequestIds.add(m.waMessageId);
        // The server posts its own group announcement on a confirm, so
        // the reply here is null in every branch and only the react
        // speaks — byte-identical to `route.ts:3199-3206`.
        let react: string | null = null;
        try {
          const result = await resolveBenchConfirmation({
            matchId: nextMatchForReply.id,
            userId: sender.userId,
            decision: answer === "yes",
          });
          if (result.kind === "confirmed") react = "✅";
          else if (result.kind === "declined") react = "👋";
          // "ignored" — the prompt was resolved between the read above
          // and here. Say nothing; there is nothing true to say.
        } catch (err) {
          console.error("[analyze] bench-prompt answer failed:", err);
        }
        await recordAnalysis({
          orgId: org.id, groupId: body.groupId, msg: m,
          handledBy: "fast-path", intent: "bench_confirmation",
          action: react ? `bench-${answer}` : "none",
          confidence: 1,
          reasoning: `bench prompt open for this sender; answer read as "${answer}"`,
          authorUserId: sender.userId, authorName: m.authorName ?? null,
        });
        results.push({
          waMessageId: m.waMessageId, handledBy: "fast-path",
          intent: "bench_confirmation", react, reply: null,
        });
      }
    }
  }

  // ── 4. THE PASTED ROSTER ───────────────────────────────────────────
  //
  //   `attendance-engine-batch.ts:280` refuses any message
  //   `parsePastedRoster` recognises, because "a fourteen-line roster
  //   routed `other_att` is fourteen third-party IN claims it would
  //   happily apply". The shipped handling lived in the per-message loop
  //   and read the model's `registerFor`.
  //
  //   THE ARITHMETIC WAS NEVER THE MODEL'S. `reconcilePastedRoster`
  //   decides whether the paste restates our own roster post in Match
  //   Context order and, if it does, COMPUTES which lines are new. The
  //   old code took the model's picks off the list and threw all of them
  //   away, replacing them with that computation. So the peel loses only
  //   the residue — names the model found that the LIST does not
  //   mention, i.e. prose travelling alongside a paste ("here's the
  //   list, also adding Kieran"). Kieran now needs one more message,
  //   which is §13's stated trade: "a missed add is recoverable in one
  //   message; a wrong registration on a paid match is not."
  //
  //   Anything that is NOT of record registers NOBODY — the clamp's
  //   outcome, reached by construction rather than by subtraction, since
  //   with no model there are no list-derived writes to clamp.
  if (nextMatchForReply) {
    const confirmedNames = nextMatchForReply.attendances.map((a) => a.user.name ?? "");
    for (const m of fresh) {
      if (statsRequestIds.has(m.waMessageId)) continue;
      const sender = senderById.get(m.waMessageId)!;
      const decision = decidePastedRosterRegistration({
        body: m.body,
        confirmedNames,
        senderNames: [sender.name, m.authorName],
      });
      if (decision.kind === "not_a_roster") continue;
      statsRequestIds.add(m.waMessageId);

      if (decision.kind === "not_of_record") {
        console.warn(
          `[analyze] pasted-roster: "${(m.body || "").slice(0, 60)}" (${m.waMessageId}) is a ` +
            `pasted list that does not restate the squad (${decision.reason}) — registering nobody. ` +
            `A re-paste is a restatement, not a registration; org ${org.id} should use ` +
            `featureSquadFromList if it maintains its squad this way.`,
        );
        await recordAnalysis({
          orgId: org.id, groupId: body.groupId, msg: m,
          handledBy: "fast-path", intent: "pasted_roster", action: "none",
          confidence: 1, reasoning: `pasted roster, not of record (${decision.reason}) — nobody registered`,
          authorUserId: sender.userId, authorName: m.authorName ?? null,
        });
        results.push({
          waMessageId: m.waMessageId, handledBy: "fast-path",
          intent: "pasted_roster", react: null, reply: null,
        });
        continue;
      }

      // Of record. The appended names are new, arithmetically.
      const failures: string[] = [];
      const registered: string[] = [];
      for (const name of decision.additions) {
        const isSender = name === decision.senderAddition;
        try {
          const target =
            isSender && sender.userId
              ? { userId: sender.userId, name: sender.name }
              : await resolveOrProvisionByName(org.id, name);
          if (!target) {
            failures.push(name);
            continue;
          }
          await registerAttendance(target.userId, nextMatchForReply.id, {
            // The `pasted-roster` cause already exists in
            // `attendance-events.ts` for the `featureSquadFromList`
            // pipeline. This is the same event for the same reason on a
            // different door, so it reuses the cause rather than
            // inventing a synonym nobody would think to query for.
            event: {
              cause: "pasted-roster",
              actorKind: isSender ? "player" : "member",
              actorUserId: sender.userId ?? null,
              sourceRef: m.waMessageId,
              note: "appended to a pasted roster that restates the squad (S26)",
            },
          });
          registered.push(target.name ?? name);
        } catch (err) {
          console.error(`[analyze] pasted-roster register failed for ${name}:`, err);
          failures.push(name);
        }
      }
      console.warn(
        `[analyze] pasted-roster reconcile: "${(m.body || "").slice(0, 60)}" (${m.waMessageId}) ` +
          `restates the confirmed squad in order, so the ${decision.additions.length} appended ` +
          `name(s) [${decision.additions.join(", ")}] are new. Computed from the squad, not from ` +
          `anyone's reading of the list.`,
      );
      await recordAnalysis({
        orgId: org.id, groupId: body.groupId, msg: m,
        handledBy: failures.length > 0 ? "error" : "fast-path",
        intent: "pasted_roster",
        action: registered.length > 0 ? `register:${registered.length}` : "none",
        confidence: 1,
        reasoning:
          `pasted roster of record — registered [${registered.join(", ")}]` +
          (failures.length > 0 ? `; FAILED for [${failures.join(", ")}]` : ""),
        authorUserId: sender.userId, authorName: m.authorName ?? null,
      });
      // The honest ack: nothing cheerful is said about a write that
      // threw, and the squad post below is composed from the DATABASE
      // after every write in this request has landed, so it shows what
      // actually happened either way (9f19040, §3.2 S7).
      results.push({
        waMessageId: m.waMessageId,
        handledBy: failures.length > 0 ? "error" : "fast-path",
        intent: "pasted_roster",
        react: failures.length > 0 ? null : registered.length > 0 ? "✅" : null,
        reply: registered.length > 0 ? SQUAD_POST_MARKER : null,
      });
    }
  }

  // Drop every peeled message from the batch the pipeline sees. ONE
  // splice for all of them, after the last peel, so a peel added later
  // cannot leave its message in the batch for an owner to claim as well.
  for (let i = fresh.length - 1; i >= 0; i--) {
    if (statsRequestIds.has(fresh[i].waMessageId)) fresh.splice(i, 1);
  }

  const history = (body.history ?? []).map((h) => ({
    authorName: h.authorName,
    body: h.body,
    timestamp: new Date(h.timestamp),
  }));

  // ── §10 STEP 5 — THE ROUTER GATE, NO LONGER BEHIND A FLAG ──────────
  //
  //   "`none`-routed messages skip the analyzer; everything else hits
  //    the existing prompt unchanged."
  //
  // 69.3% of real traffic is banter (measured over 1,723 production
  // messages, PR #35). A cheap Haiku router decides which messages the
  // rest of the pipeline is spent on.
  //
  // ─────────────────────────────────────────────────────────────────
  // `ROUTER_GATE_ENABLED` AND `ATTENDANCE_ENGINE_ENABLED` ARE GONE
  // ─────────────────────────────────────────────────────────────────
  //
  // Both were reverts, and the thing they reverted TO was `analyzeBatch`.
  // Step 8 deletes it, so their "off" positions stopped being reverts and
  // became something much worse:
  //
  //   • `ATTENDANCE_ENGINE_ENABLED=0` would leave NOBODY handling
  //     `self_att` / `other_att` / `offer` / `unsure`. Every "IN", every
  //     "sorry lads can't make it", every admin demote would be silence
  //     plus an operator note. That is not a lever, it is a kill switch
  //     for the product's core write path with a name that reads like a
  //     tuning flag.
  //   • `ROUTER_GATE_ENABLED=0` used to mean "the analyzer sees the
  //     banter too". With no analyzer it means only that `gatedIds` is
  //     empty, and every owner already refuses a `none` route on its own
  //     — so the flag is inert, and an inert flag is `gate.ts:227`'s
  //     "worst kind of flag" seen from the other side.
  //
  // A flag whose off position has no implementation is worse than no
  // flag, so both are deleted rather than defaulted ON. **The revert for
  // step 8 is `git revert`, and that is worth saying plainly rather than
  // leaving a switch that looks like one.** The four STEP-7 route flags
  // are kept and default ON, because THEIR off position is a survivable
  // degradation — see `pipeline/route-flags.ts`.
  //
  // THREE THINGS THE GATE DELIBERATELY DOES NOT DO, unchanged:
  //
  //   1. It does not remove skipped messages from `fresh`. Later passes
  //      scan the whole batch, and a `none` message vanishing would
  //      change what they conclude about its neighbours.
  //   2. It does not decide anything. It labels.
  //   3. It does not go silent. A skipped message still gets its
  //      `AnalyzedMessage` row, tagged `router-gate` — §11.1's complaint
  //      about the `none` bucket is that the message disappears with "no
  //      `AnalyzedMessage.action`", and this is what makes "did the gate
  //      eat an IN?" a query. That row matters MORE now that it is the
  //      nightly `none`-bucket sweep's only input.
  const gate =
    fresh.length > 0 && routerIsNeeded()
      ? await gateBatch(
          fresh.map((m) => ({
            waMessageId: m.waMessageId,
            body: m.body,
            authorName: m.authorName,
          })),
          // The ONE thing the router was missing, and the reason PR #42
          // would not turn this flag on: a bare `👍` answering a slot
          // MatchTime had left open routes `none`, and the write is
          // lost. Both of the two real cases in 1,695 production
          // messages are that. It is not a pattern — the `👍` is banter
          // far more often than it is a registration — so the fix is a
          // ROW: is there an unanswered `BenchSlotOffer` /
          // `PendingBenchConfirmation` / `TentativeAvailability` on the
          // board right now? See `src/lib/pipeline/awaiting-answer.ts`.
          // Null 99% of the time, and with it nothing changes at all.
          { awaiting: await loadOpenQuestion(org.id) },
        )
      : null;
  const gatedIds = new Set(gate?.skipped ?? []);
  const gateRouteById = new Map((gate?.routes ?? []).map((r) => [r.messageId, r.route]));
  if (gate) {
    for (const d of gate.degradations) {
      console.warn(`[analyze] router-gate degraded (${d.messageId ?? "batch"}): ${d.detail}`);
    }
    console.log(
      `[analyze] router: ${gate.routes.length}/${fresh.length} routed, ` +
        `${gatedIds.size} banter, ${gate.floorForced.length} floor-forced, ` +
        `${gate.awaitingForced.length} forced by an open question ` +
        `(floor ${gate.floorEnabled ? "ON" : "OFF"})` +
        (gate.usage
          ? `, router $${(gate.usage.costUsd ?? 0).toFixed(5)} in ${gate.usage.ms}ms`
          : ", no router call"),
    );
  }

  // ── §10 STEP 6 — THE ATTENDANCE ENGINE, NOW THE ONLY DECIDER ───────
  //
  //   "Swap the attendance path to extractor + engine. `self_att`,
  //    `other_att`, `offer` only — the three routes covering every
  //    incident in the archive."
  //
  // FOUR routes since step 8: `unsure` joined them, because the thing
  // it used to fall back to no longer exists. See the essay on
  // `ENGINE_ROUTES` in `pipeline/gate.ts` — it also makes `router.ts`'s
  // router-failure comment true, which is the whole of §11.4's
  // containment.
  //
  // It still runs FIRST, and the reason is unchanged even though what it
  // runs ahead of has changed: two deciders for one message would mean
  // two replies for one message, and "MatchTime replies once or not at
  // all" is the invariant the whole tail of this function protects.
  //
  // It fails open on every axis it always did — no match, attendance off
  // for the org, an unroutable id, a bench prompt open for the sender, a
  // pasted roster, a state load that threw. What "fails open" MEANS has
  // changed and that is step 8's whole risk: those messages used to go
  // to the analyzer and now go to silence plus an operator note. Each
  // one is enumerated in `lib/attendance-engine-batch.ts`'s header, and
  // the two that carried real traffic got deterministic owners of their
  // own rather than being left to the note — a bench-prompt answer
  // (`lib/bench-prompt-answer.ts`) and a pasted roster
  // (`lib/pasted-roster-registration.ts`), both peeled before the router
  // runs.
  //
  // REVERT: `git revert`. The flag that used to sit here is gone — see
  // the essay above the router gate for why a switch whose off position
  // is "nobody handles attendance" is not a revert.
  const engineAdminIds = new Set(
    (
      await db.membership.findMany({
        where: { orgId: org.id, role: { in: ["OWNER", "ADMIN"] }, leftAt: null },
        select: { userId: true },
      })
    ).map((m) => m.userId),
  );
  const engineBatch =
    fresh.length > 0
      ? await runAttendanceEngineBatch({
          orgId: org.id,
          now: new Date(),
          expectedMatchId: activeMatchForReply?.id ?? null,
          enabled: true,
          history: history.map((h) => ({ author: h.authorName, body: h.body })),
          messages: fresh.map((m) => {
            const s = senderById.get(m.waMessageId)!;
            return {
              waMessageId: m.waMessageId,
              body: m.body,
              authorName: m.authorName,
              senderUserId: s.userId,
              senderName: s.name,
              senderIsAdmin: !!s.userId && engineAdminIds.has(s.userId),
              tagged: messageTagsBot(m),
              route: gateRouteById.get(m.waMessageId),
              gated: gatedIds.has(m.waMessageId),
            };
          }),
          deps: {
            registerAttendance,
            cancelAttendance,
            resolveOrProvision: (name) => resolveOrProvisionByName(org.id, name),
            openBenchPromptUserIds: async (matchId) =>
              (
                await db.pendingBenchConfirmation.findMany({
                  where: { matchId, resolvedAt: null },
                  select: { userId: true },
                })
              ).map((p) => p.userId),
          },
        })
      : null;
  const engineOwnedIds = engineBatch?.ownedIds ?? new Set<string>();
  // WHAT THE ENGINE DID, AND WHAT IT LOST — the lines are composed by a
  // pure function so the SELECTION of them is unit-testable.
  //
  // They used to be composed here behind `if (engineOwnedIds.size > 0)`,
  // which silenced them in exactly the case they exist for. A batch
  // where EVERY extraction failed — the total-overload edge — ends with
  // `ownedIds` empty, and `attendance-engine-batch.ts` goes out of its
  // way to carry the degradations through that early return precisely so
  // they could be printed ("returning the bare empty result would throw
  // away the only record of why the engine went quiet"). The gate threw
  // them away one layer up, and a batch that had just lost its whole
  // extraction became indistinguishable from one where the flag was
  // simply off. Found by asking what the fail-open path looks like at
  // its WORST, rather than whether it works at all.
  if (engineBatch) {
    const report = describeEngineBatch(engineBatch, fresh.length);
    for (const w of report.warns) console.warn(w);
    if (report.info) console.log(report.info);
  }

  // ── §10 STEP 8 — THE LAST FOUR OWNERS, AND THE END OF THE PROMPT ───
  //
  //   "Migrate the rest — `question`, `balancer`, `score`, `admin_ops`,
  //    one per week. RETIRE THE MEGA-PROMPT WHEN THE LAST ROUTE LEAVES."
  //
  // They have left. What stood between this comment and the loop below
  // — the `BatchInputMessage[]`, the single `analyzeBatch` call, the
  // re-expansion into one `AnalysisVerdict` per message, and the
  // partial-response net that prefix-matched six strings against
  // `verdict.reasoning` — is deleted in this change, along with
  // `analyzeBatch` and the 19,850-token `SYSTEM_PROMPT` themselves.
  //
  // ─────────────────────────────────────────────────────────────────
  // WHAT REPLACED THE PARTIAL-RESPONSE NET
  // ─────────────────────────────────────────────────────────────────
  // §9 lists it among the twenty-two seatbelts that SURVIVE, with one
  // instruction: "Keep, but fix the mechanism: today it prefix-matches
  // free-text `reasoning`; under the new design it matches a typed
  // error, which is what it always wanted to be."
  //
  // This is that fix, and the typed fact is ownership. A message that
  // reached the end of the batch with no owner is exactly the event the
  // old net was reaching for — "understood by a human, silently not
  // acted on by the bot" — stated as a property of the request rather
  // than reconstructed from a sentence the model wrote. It is composed
  // after the loop by `lib/operator-note.ts`, sent to the same admins,
  // on the same one-hour dedupe.
  //
  // ─────────────────────────────────────────────────────────────────
  // WHY THEY RUN HERE, AND IN SEQUENCE
  // ─────────────────────────────────────────────────────────────────
  // Before anything speaks, for the reason step 6 gives above: "two
  // deciders for one message would mean two replies for one message,
  // and 'MatchTime replies once or not at all' is the invariant the
  // whole tail of this function protects."
  //
  // In SEQUENCE rather than `Promise.all`, because `score`, `admin_ops`
  // and `balancer`-generate all write, and three write paths racing
  // against the same match is a hazard bought for nothing: each runner
  // makes ZERO model calls for a batch carrying none of its routes
  // (every one of them filters candidates by route before loading state
  // — `answer-batch.ts:388`, `score-engine-batch.ts:198`,
  // `admin-ops-engine-batch.ts:198`), so the ordering costs latency only
  // on the rare batch that genuinely carries two of them.
  //
  // ─────────────────────────────────────────────────────────────────
  // OWNERSHIP IS DISJOINT, AND IT IS ASSERTED
  // ─────────────────────────────────────────────────────────────────
  // Each runner claims a fixed, non-overlapping set of routes
  // (`ANSWER_ENGINE_ROUTES`, `SCORE_ENGINE_ROUTES`,
  // `ADMIN_OPS_ENGINE_ROUTES`, plus step 6's `ENGINE_ROUTES`), so two
  // owners cannot claim one id. `assertOneOwnerPerMessage` says so out
  // loud anyway: a double claim is the one defect whose symptom is the
  // bot replying twice in a customer's group, and it must not be
  // something only a code reading can rule out.
  const ownerBase = fresh.map((m) => {
    const s = senderById.get(m.waMessageId)!;
    return {
      waMessageId: m.waMessageId,
      body: m.body,
      authorName: m.authorName,
      senderUserId: s.userId,
      senderName: s.name,
      tagged: messageTagsBot(m),
      route: gateRouteById.get(m.waMessageId),
      gated: gatedIds.has(m.waMessageId),
    };
  });
  const ownerHistory = history.map((h) => ({ author: h.authorName, body: h.body }));
  const now = new Date();

  // The step-7 routes live for this request. The test-only per-request
  // header still works (it is inert unless MT_TEST_MODE is "1"), which
  // is what lets a live A/B move one route at a time without a deploy.
  const stepSevenEnabled = enabledStepSevenRoutes(
    process.env,
    routesHeaderOverride(request.headers.get(STEP_SEVEN_HEADER)),
  );

  const answerBatch =
    fresh.length > 0
      ? await runAnswerBatch({
          orgId: org.id,
          now,
          messages: ownerBase,
          history: ownerHistory,
          // Same contract as step 6: if the route's registration match
          // and the owner's state load ever disagree, the owner takes
          // nothing rather than answer about a different match.
          expectedMatchId: activeMatchForReply?.id ?? null,
          enabled: stepSevenEnabled,
          deps: {},
        })
      : null;

  const scoreBatch =
    fresh.length > 0
      ? await runScoreBatch({
          orgId: org.id,
          now,
          messages: ownerBase,
          history: ownerHistory,
          enabled: stepSevenEnabled,
          deps: buildScoreApplyDeps(),
        })
      : null;

  const adminOpsBatch =
    fresh.length > 0
      ? await runAdminOpsBatch({
          orgId: org.id,
          now,
          messages: ownerBase,
          history: ownerHistory,
          enabled: stepSevenEnabled,
          deps: {
            ...buildAdminOpsApplyDeps({ orgId: org.id }),
            // The per-category opt-out (`Membership.subReminderDm`), which
            // `route.ts:3959` read one row at a time. Loaded once per
            // batch here; the engine does the rest.
            reminderMutedUserIds: async () =>
              (
                await db.membership.findMany({
                  where: { orgId: org.id, leftAt: null, subReminderDm: false },
                  select: { userId: true },
                })
              ).map((r) => r.userId),
          },
        })
      : null;

  // `balancer`, action `generate`. The other half of the route
  // `runAnswerBatch` owns: that one answers `show` and has no apply
  // layer at all, this one runs the balancer and writes every
  // `TeamAssignment`. Split on a FACT the extractor returns
  // (`facts.action`) rather than on a flag, so ONE route keeps ONE flag
  // and the two handlers cannot both claim a message —
  // `route-flags.test.ts` asserts the predicates are disjoint.
  //
  // It is not optional in the way the others are: 23 of the last 120
  // days' tagged commands to MatchTime were "generate the teams", more
  // than every question shape combined. Silence here would not be a
  // conservative default, it would be the feature going dark.
  const teamOpsBatch =
    fresh.length > 0
      ? await runTeamOpsBatch({
          orgId: org.id,
          now,
          messages: ownerBase,
          history: ownerHistory,
          enabled: stepSevenEnabled,
          deps: buildTeamOpsApplyDeps({ orgId: org.id }),
        })
      : null;

  const ownerDegradations = [
    ...(answerBatch?.degradations ?? []),
    ...(scoreBatch?.degradations ?? []),
    ...(adminOpsBatch?.degradations ?? []),
    ...(teamOpsBatch?.degradations ?? []),
    ...(engineBatch?.degradations ?? []),
  ];
  for (const d of ownerDegradations) console.warn(`[analyze] ${d}`);

  // ── ONE OWNER PER MESSAGE, ASSERTED ────────────────────────────────
  //   The invariant that used to be bought by there being exactly one
  //   decider. There are five now, so it is checked. A double claim is
  //   logged as an error and the LATER claim is dropped, in the same
  //   shape as the duplicate-result backstop at the end of this
  //   function: a violated invariant must degrade to "reply once",
  //   never to "throw and lose the batch".
  const ownerOf = new Map<string, string>();
  const claim = (label: string, ids: Iterable<string>) => {
    for (const id of ids) {
      const prior = ownerOf.get(id);
      if (prior) {
        console.error(
          `[analyze] INVARIANT VIOLATION: ${id} claimed by BOTH ${prior} and ${label} — ` +
            `keeping ${prior} so MatchTime replies once`,
        );
        continue;
      }
      ownerOf.set(id, label);
    }
  };
  // Two things about these five lines.
  //
  // The labels are each module's OWN `*_HANDLED_BY` constant, not a
  // string typed here. They are written to `AnalyzedMessage.handledBy`
  // below, so a hand-typed copy would mean the admin log said
  // "answer-batch" while the module that decided it called itself
  // "answer-engine" — which is exactly what the first draft of this line
  // did.
  //
  // And the ORDER is the same order the loop below resolves an outcome
  // in. `claim()` keeps the FIRST claimant and the loop's `??` chain
  // takes the FIRST hit, so under a double claim — which cannot happen,
  // the route sets are disjoint — the two would still agree about who
  // decided the message. The first draft had `admin_ops` third here and
  // fourth there, which would have made the audit row name one owner
  // while another one's words went to the group. That is a smaller bug
  // than the one this assertion exists for, and it is exactly the kind
  // that survives because nobody looks at the impossible branch.
  claim(ENGINE_HANDLED_BY, engineOwnedIds);
  claim(ANSWER_HANDLED_BY, answerBatch?.ownedIds ?? []);
  claim(SCORE_HANDLED_BY, scoreBatch?.ownedIds ?? []);
  claim(TEAM_OPS_HANDLED_BY, teamOpsBatch?.ownedIds ?? []);
  claim(ADMIN_OPS_HANDLED_BY, adminOpsBatch?.ownedIds ?? []);

  // ── 3. TURN EACH OWNER'S OUTCOME INTO ONE REPLY AND ONE ROW ────────
  //
  //   This loop used to be 1,180 lines. Almost all of it was the model's
  //   output being corrected: the hypothetical/past-tense seatbelt, the
  //   third-party-subject seatbelt, the placeholder-guest strip, the
  //   pasted-roster reconcile and clamp, the guest-name ask, the tag
  //   gate, the attendance-off gate, the conditional-drop hold, the IN
  //   net, the OUT net, the bench-demote net, the banter-drop guard, the
  //   generate-teams dedupe, and `executeVerdict` itself.
  //
  //   Every one of them read `verdict.intent`, `verdict.reasoning`,
  //   `verdict.reply`, `verdict.registerAttendance` or
  //   `verdict.registerFor`. There is no verdict any more, so their
  //   input does not exist — which is §9's "no longer possible: the
  //   error class becomes unrepresentable, so the guard has nothing to
  //   guard", spent rather than promised. The per-guard proofs live in
  //   the commit that deleted them and in `MDs/`.
  //
  //   What survives is what §9 said would: the honest ack, the
  //   unresolved-sender nudge, the react/status reconciliation, the one
  //   composed squad post, the deferred recruit blast, and the
  //   one-result-per-message backstop. Not one of those was ever about
  //   the model.
  //
  //   So the loop now does exactly three things per message: find the
  //   owner, render its outcome, or record that nobody owned it.

  // Sender-registration reacts to audit AFTER the whole batch has been
  // applied (see the reaction ↔ status reconciliation pass below). Only
  // outcomes where the react describes the SENDER's own attendance row
  // qualify.
  const REGISTRATION_STATUS_REACTS = new Set(["✅", "🪑", "👋"]);
  const senderReactAudit: Array<{ idx: number; userId: string }> = [];

  // ── THE RECRUIT BLAST STILL RUNS LAST ───────────────────────────────
  //   Collected here, fired once after every write in the batch has
  //   landed — see "RUN THE RECRUIT" below. The deferral is the fix for
  //   2026-09-01, where a blast ran BEFORE the batch's writes and told
  //   the owner his squad was full one line after he said Najib was out.
  //   Two owners can report one: step 6's engine (`sideRequests`
  //   carrying "recruit" from an admin) and step 7's `admin_ops` (an
  //   explicit "DM the lads from the last 5 games", with a clamped
  //   lookback). They share this list so the "only the last one fires"
  //   rule holds across both.
  const recruitRequests: Array<{
    msg: InboundMessage;
    sender: ResolvedSender;
    lookbackMatches: number | null;
  }> = [];

  // ── EVERY MESSAGE NOBODY OWNED ─────────────────────────────────────
  //   The input to `lib/operator-note.ts`, which is what replaces "fall
  //   back to the analyzer". A `none`-routed message lands here too and
  //   is filtered out there, deliberately: the decision about what is
  //   worth a human's attention is made in ONE place, and it is made on
  //   the route rather than on the message text.
  const unowned: UnownedMessage[] = [];

  for (const msg of fresh) {
    const sender = senderById.get(msg.waMessageId)!;

    // ── §10 STEP 6 — THE ATTENDANCE ENGINE DECIDED THIS MESSAGE ──────
    //
    // The extractor read it, the engine decided it, `attendance.ts`
    // wrote it and the composer said it. Unchanged by step 8 except
    // that there is no longer anything below it to skip.
    const engineOutcome = engineBatch?.outcomes.get(msg.waMessageId);
    if (engineOutcome) {
      if (engineOutcome.recruitRequest) {
        recruitRequests.push({ msg, sender, lookbackMatches: null });
      }
      if (engineOutcome.recordTentativeForUserId && engineBatch?.matchId && nextMatchForReply) {
        // conditional_in flavour (b) — personal uncertainty. The engine
        // declines the write; the 24h chase is a shipped product
        // behaviour and step 6 must not lose it. Best-effort.
        await recordTentative({
          matchId: engineBatch.matchId,
          userId: engineOutcome.recordTentativeForUserId,
          kickoff: nextMatchForReply.date,
        }).catch((err) => console.error("[analyze] engine recordTentative failed:", err));
      }
      if (engineOutcome.resolveTentativeForUserId && engineBatch?.matchId) {
        await resolveTentative({
          matchId: engineBatch.matchId,
          userId: engineOutcome.resolveTentativeForUserId,
        }).catch((err) => console.error("[analyze] engine resolveTentative failed:", err));
      }

      // The honest ack: a confirmation is NEVER sent for a write that
      // did not land (9f19040).
      const ack = resolveAttendanceAck({
        failures: engineOutcome.failures,
        react: engineOutcome.react,
        reply: engineOutcome.reply,
        senderName: sender.name ?? msg.authorName ?? null,
      });
      if (ack.failed) {
        console.error(attendanceFailureLog(engineOutcome.failures), "for", msg.waMessageId);
        await recordAnalysis({
          orgId: org.id,
          groupId: body.groupId,
          msg,
          handledBy: "error",
          intent: engineOutcome.intent,
          action: attendanceFailureAction(engineOutcome.failures),
          confidence: 1,
          reasoning: attendanceFailureLog(engineOutcome.failures).slice(0, 2000),
          authorUserId: sender.userId,
          authorName: msg.authorName ?? null,
        });
        results.push({
          waMessageId: msg.waMessageId,
          handledBy: "error",
          intent: engineOutcome.intent,
          react: null,
          reply: ack.reply,
          reasoning: engineOutcome.reasoning,
        });
        continue;
      }

      let engineReply = ack.reply;
      // NOTE: the batch's squad post is NOT attached here. It is
      // attached after the whole loop, to whichever message ends up
      // speaking last — see "THE BATCH'S ONE SQUAD POST" below.
      if (engineReply && nextMatchForReply) {
        engineReply = enforceProximity(engineReply, nextMatchForReply.date);
      }
      const engineNudge = await unresolvedSenderNudge({
        senderResolved: !!sender.userId,
        attendanceRelevant: engineOutcome.action !== "none",
        matchId: nextMatchForReply?.id ?? null,
        authorName: msg.authorName,
        dropping: engineOutcome.intent === "out",
      });
      if (engineNudge.applies) engineReply = engineNudge.reply;

      await recordAnalysis({
        orgId: org.id,
        groupId: body.groupId,
        msg,
        handledBy: ENGINE_HANDLED_BY,
        intent: engineOutcome.intent,
        action: engineOutcome.action,
        confidence: 1,
        reasoning: engineOutcome.reasoning,
        authorUserId: sender.userId,
        authorName: msg.authorName ?? null,
      });
      if (
        sender.userId &&
        nextMatchForReply &&
        ack.react !== null &&
        REGISTRATION_STATUS_REACTS.has(ack.react) &&
        engineOutcome.senderOwnRowMoved
      ) {
        senderReactAudit.push({ idx: results.length, userId: sender.userId });
      }
      results.push({
        waMessageId: msg.waMessageId,
        // The WIRE field, which `whatsapp-bot/src/api.ts:325` types as a
        // closed union the Pi only special-cases for `deduped` and
        // `error`. The AUDIT field on `AnalyzedMessage` above says
        // `attendance-engine`, which is what makes "what did the engine
        // decide?" one query.
        handledBy: "llm",
        intent: engineOutcome.intent,
        react: ack.react,
        reply: engineReply,
        reasoning: engineOutcome.reasoning,
      });
      continue;
    }

    // ── §10 STEP 7 — question, balancer, score, admin_ops ────────────
    //
    // Three runners, one shape. They are looked up with `??` rather
    // than in three branches because their route sets are disjoint
    // (asserted by `claim()` above), so at most one can answer — and
    // writing it once means the ack, the proximity pass and the
    // `AnalyzedMessage` row cannot drift apart between them.
    //
    // WHAT THIS BRANCH DELIBERATELY DOES NOT DO, and each is covered:
    //
    //   • No tag gate. `answer-batch.ts` requires `m.tagged`
    //     unconditionally and `admin-ops-engine-batch.ts` applies the
    //     contract per action; `score` is EXCLUDED from ACTIONY_INTENTS
    //     by name (`interaction-contract.ts:125-129`), so a gate here
    //     would refuse every real "we won 5-3". Re-applying it would be
    //     a second copy of a policy that already ran.
    //   • No feature gate. Each runner reads the org's features out of
    //     its own `SquadState` load and owns nothing when its feature is
    //     off, which is strictly better than this branch checking after
    //     the write.
    //   • No unresolved-sender nudge. That nudge exists for a lost
    //     ATTENDANCE change ("message understood, action silently not
    //     taken") and step 6's branch above still applies it. A question
    //     or a score from an unresolved sender is answered on purpose —
    //     `score-engine-batch.ts`'s header: "losing the score entirely
    //     is a worse failure mode".
    //   • No squad-post marker. Attached after the loop, once, to
    //     whichever result speaks last.
    // `admin_ops` is looked up into its OWN binding rather than being
    // folded into the `??` chain, so the recruit fields keep their real
    // types: a `"recruitRequest" in x` test over a three-way union
    // narrows to "has the key", not to the member that declares it, and
    // `recruitLookbackMatches` comes back as `{}`.
    const adminOutcome = adminOpsBatch?.outcomes.get(msg.waMessageId);
    const stepSeven =
      answerBatch?.outcomes.get(msg.waMessageId) ??
      scoreBatch?.outcomes.get(msg.waMessageId) ??
      teamOpsBatch?.outcomes.get(msg.waMessageId) ??
      adminOutcome;
    if (stepSeven) {
      // An admin's recruit ask, deferred to the batch-final pass with
      // its clamped lookback. `recruitLookbackMatches` is null when the
      // ask did not state a number, and `inviteRecentPlayers` then uses
      // its own default of 5.
      if (adminOutcome?.recruitRequest) {
        recruitRequests.push({
          msg,
          sender,
          lookbackMatches: adminOutcome.recruitLookbackMatches ?? null,
        });
      }
      // A write that threw says nothing at all (§3.2 S7, the 2026-05-15
      // Erdal incident). The runner has already blanked the reply; this
      // only labels the row so the failure is one query away rather than
      // one log line away.
      const writeFailed = "writeFailed" in stepSeven && stepSeven.writeFailed;
      let reply = stepSeven.reply;
      if (reply && nextMatchForReply) {
        reply = enforceProximity(reply, nextMatchForReply.date);
      }
      await recordAnalysis({
        orgId: org.id,
        groupId: body.groupId,
        msg,
        handledBy: writeFailed ? "error" : ownerOf.get(msg.waMessageId) ?? "llm",
        intent: stepSeven.intent,
        action: stepSeven.action,
        confidence: 1,
        reasoning: stepSeven.reasoning,
        authorUserId: sender.userId,
        authorName: msg.authorName ?? null,
      });
      results.push({
        waMessageId: msg.waMessageId,
        handledBy: writeFailed ? "error" : "llm",
        intent: stepSeven.intent,
        react: writeFailed ? null : stepSeven.react,
        reply,
        reasoning: stepSeven.reasoning,
      });
      continue;
    }

    // ── NOBODY OWNED IT ─────────────────────────────────────────────
    //
    // This is where "fall back to the analyzer" used to point, and the
    // whole of §10 step 8's risk lives in these six lines.
    //
    // MatchTime says NOTHING to the group. That is §11.5's accepted
    // loss, named in advance: "a router with nine routes and an engine
    // with explicit rules will do nothing instead… the club will
    // experience it as 'the bot got dumber' before they experience it
    // as 'the bot stopped being wrong'." For a system writing to a paid
    // squad, doing nothing is the right default.
    //
    // But silence with no signal is §9's SIGNATURE failure, so the
    // silence is recorded twice: once as an `AnalyzedMessage` row (so
    // "did the pipeline eat an IN?" is a query, which is §11.1's third
    // containment and §11.2's mitigation), and once — for the routes
    // that were actually going somewhere — as an operator DM composed
    // after the loop. `composeOperatorNote` drops `none` there; it is
    // NOT dropped here, because the row is what makes the nightly
    // `none`-bucket sweep possible.
    unowned.push({
      waMessageId: msg.waMessageId,
      body: msg.body,
      authorName: msg.authorName,
      route: gateRouteById.get(msg.waMessageId),
    });
    await recordAnalysis({
      orgId: org.id,
      groupId: body.groupId,
      msg,
      handledBy: gatedIds.has(msg.waMessageId) ? GATED_HANDLED_BY : "ignored",
      intent: "noise",
      action: null,
      confidence: 1,
      reasoning:
        `no owner: route=${gateRouteById.get(msg.waMessageId) ?? "(none returned)"}` +
        (ownerDegradations.find((d) => d.includes(msg.waMessageId))
          ? ` — ${ownerDegradations.find((d) => d.includes(msg.waMessageId))!.slice(0, 400)}`
          : ""),
      authorUserId: sender.userId,
      authorName: msg.authorName ?? null,
    });
    results.push({
      waMessageId: msg.waMessageId,
      handledBy: "ignored",
      intent: "noise",
      react: null,
      reply: null,
    });
  }

  // ── THE OPERATOR NOTE — §9's PARTIAL-RESPONSE NET, TYPED ───────────
  //
  //   The successor to the "LLM dropped N messages" DM that stood before
  //   the loop until this change. §9 keeps that seatbelt and says how to
  //   fix it: "today it prefix-matches free-text `reasoning`; under the
  //   new design it matches a typed error, which is what it always
  //   wanted to be." The typed fact is that an id reached the end of the
  //   batch with no owner.
  //
  //   Same audience, same 1-hour dedupe, same "act manually if any were
  //   attendance changes" close. Two things changed and both are
  //   improvements: it can no longer be defeated by the model phrasing
  //   its failure differently, and it no longer fires for banter,
  //   because `composeOperatorNote` drops every `none` route (69.3% of
  //   real traffic — a DM per banter message is an ignored surface,
  //   which is the same silence with extra steps).
  //
  //   Best-effort by construction: the note is the last thing that
  //   happens to a batch that already replied, so a failure here must
  //   never cost the group its reply.
  if (unowned.length > 0) {
    try {
      const note = composeOperatorNote({
        orgName: org.name,
        messages: unowned,
        degradations: ownerDegradations,
      });
      if (note.text) {
        console.warn(
          `[analyze] ${note.noteIds.length} message(s) reached the end of the batch with no owner: ` +
            note.noteIds.join(", "),
        );
        const admins = await db.membership.findMany({
          where: { orgId: org.id, role: { in: ["ADMIN", "OWNER"] }, leftAt: null },
          include: { user: { select: { id: true, phoneNumber: true, name: true } } },
        });
        const since = new Date(Date.now() - 60 * 60 * 1000); // 1h dedupe window
        for (const m of admins) {
          if (!m.user.phoneNumber) continue;
          const phone = m.user.phoneNumber.replace(/^\+/, "");
          const recentlySent = await db.botJob.findFirst({
            where: {
              orgId: org.id,
              kind: "dm",
              phone,
              text: { contains: OPERATOR_NOTE_MARKER },
              createdAt: { gte: since },
            },
            select: { id: true },
          });
          if (recentlySent) continue; // already told this admin in the last hour
          await db.botJob.create({
            data: { orgId: org.id, kind: "dm", phone, text: note.text },
          });
        }
      }
    } catch (err) {
      console.error("[analyze] failed to dispatch the operator note:", err);
    }
  }

  // 3a-i. Reaction ↔ persisted-status reconciliation ──────────────────
  //   (Zeeshan 2026-06-12: MT reacted 🪑 to his message but his row
  //   ended DROPPED.) A registration react (✅/🪑/👋) on a sender's own
  //   attendance message is a public claim about their FINAL status —
  //   derive it from the DB after ALL of the batch's writes have
  //   landed, not from whatever the verdict guessed mid-batch.
  if (nextMatchForReply && senderReactAudit.length > 0) {
    try {
      const auditUserIds = [...new Set(senderReactAudit.map((a) => a.userId))];
      const rowsNow = await db.attendance.findMany({
        where: { matchId: nextMatchForReply.id, userId: { in: auditUserIds } },
        select: { userId: true, status: true },
      });
      const statusByUser = new Map(rowsNow.map((r) => [r.userId, r.status]));
      const reactForStatus = (s: string | undefined): string | null =>
        s === "CONFIRMED" ? "✅" : s === "BENCH" ? "🪑" : s === "DROPPED" ? "👋" : null;
      for (const { idx, userId } of senderReactAudit) {
        const want = reactForStatus(statusByUser.get(userId));
        const r = results[idx];
        if (
          want &&
          r.react &&
          REGISTRATION_STATUS_REACTS.has(r.react) &&
          r.react !== want
        ) {
          console.warn(
            `[analyze] react/status reconciliation: ${r.waMessageId} react ${r.react} → ${want} (final attendance row wins)`,
          );
          r.react = want;
        }
      }
    } catch (err) {
      console.error("[analyze] react/status reconciliation failed:", err);
    }
  }

  // ── THE BATCH'S ONE SQUAD POST, ACROSS BOTH DECIDERS (§10 step 6) ──
  //
  //   The engine posts the roster whenever the squad changed. The
  //   analyzer answers the questions in the same batch. Attach the
  //   squad post to the message the engine acted on and you get TWO
  //   sends whenever a batch contains both — measured on the first live
  //   sweep of this step, where
  //   `S36-one-authoritative-squad-post-per-batch` produced "📋 Based
  //   on all the messages…" from the engine AND "Quick correction,
  //   @Zair — we're actually…" from the analyzer, and its
  //   `speaksAtMost: 1` caught it.
  //
  //   The incumbent did not have this problem for the wrong reason: a
  //   plain "in" usually got a react and no reply at all, so the
  //   question's answer was the batch's only send. The engine speaking
  //   about every write is the improvement; two sends is the cost, and
  //   it is avoidable.
  //
  //   So the marker goes on the LAST result that is already going to
  //   speak — whichever decider produced it. `composeSquadStateReply`
  //   then renders `lead + roster` into that one message, keeping the
  //   analyzer's answer AND the database's roster in a single send, and
  //   the collapse below still guarantees at most one composed post.
  //   Nothing is lost: the lead survives unless it makes a squad claim
  //   of its own, in which case the roster it would have contradicted
  //   replaces it.
  //
  //   `[SQUAD]` rather than the composer's own text on purpose: the
  //   engine composed from its PROJECTED state, and the writes have
  //   landed since. The database is the later, truer fact, and the
  //   marker is the existing way of saying "put the real post here".
  if (engineBatch?.squadPostForMessageId) {
    const speaks = results.filter((r) => (r.reply ?? "").length > 0);
    const target =
      speaks.length > 0
        ? speaks[speaks.length - 1]
        : results.find((r) => r.waMessageId === engineBatch.squadPostForMessageId);
    if (target) {
      target.reply = target.reply
        ? `${target.reply}\n\n${SQUAD_POST_MARKER}`
        : SQUAD_POST_MARKER;
    }
  }

  // 3a-ii. THE SQUAD POST IS COMPOSED, NOT CHECKED ────────────────────
  //   §10 step 4 (2026-09-01). Every reply that shows squad state, or
  //   that claims a move the database does not support, is REPLACED by
  //   text composed from a FRESH snapshot taken AFTER every attendance
  //   write in the batch has landed. The model's numbers and names
  //   never reach the group, so they cannot be wrong, so nothing
  //   downstream has to check them (§6.4).
  //
  //   This replaces the two-branch collapse that stood here: two or
  //   more squad replies collapsed into one composed post, and a single
  //   one was re-canonicalised in place by `enforceCanonicalRoster`.
  //   The single-post branch was the hole — one reply meant the model
  //   still authored the words and 140 lines of regex tried to correct
  //   them afterwards. Root cause it was written for stands (Sutton
  //   Lads 2026-06-12: four separately-composed squad replies in one
  //   batch, each from a different snapshot, contradicting each other)
  //   and is now closed by construction, since every composed reply in
  //   a batch renders the SAME post and only the last one speaks.
  //
  //   Team posts are excluded: `generate_teams_request` /
  //   `show_teams_request` replies intentionally carry two numbered
  //   lists (Red + Yellow) and are already deterministic. That is the
  //   same exclusion the deleted in-loop pass used.
  if (nextMatchForReply) {
    try {
      const candidates: number[] = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        // `fast-path` is admitted for EXACTLY ONE intent, and narrowly.
        //
        // §10 step 8 moved the pasted-roster registration to a
        // deterministic peel that runs before the router
        // (`pasted-roster-registration.ts`), and its ack is the
        // `[SQUAD]` marker — the same "put the real post here" signal
        // every other squad-changing path uses. Without this clause the
        // filter below dropped it, the last-line-of-defence strip then
        // turned the marker into `null`, and a paste that had just
        // registered four players said NOTHING. Found by asking what
        // renders the marker rather than by assuming the composer sees
        // every reply.
        //
        // Widening the filter to all of `fast-path` would have been the
        // shorter fix and the wrong one: the help reply, the stats-blast
        // ack and the guest-name ask are also `fast-path`, and none of
        // them should be re-composed into a roster.
        const pastedRosterAck = r.handledBy === "fast-path" && r.intent === "pasted_roster";
        if (!r.reply) continue;
        if (r.handledBy !== "llm" && !pastedRosterAck) continue;
        if (r.intent === "generate_teams_request" || r.intent === "show_teams_request") continue;
        candidates.push(i);
      }
      if (candidates.length > 0) {
        const finalAtt = await db.attendance.findMany({
          where: {
            matchId: nextMatchForReply.id,
            status: { in: ["CONFIRMED", "BENCH"] },
          },
          include: { user: { select: { name: true } } },
          orderBy: { position: "asc" },
        });
        // The composer needs one fact the request does not carry: who
        // this group knows. Without it, a claim about someone with NO
        // attendance row — S7's Erdal, the exact incident — is a claim
        // about a stranger and gets waved through. Loaded here rather
        // than taken from the model (§10 step 4: "if the composer needs
        // facts the caller does not have, add a loader").
        const memberships = await db.membership.findMany({
          where: { orgId: org.id, leftAt: null },
          select: { user: { select: { name: true } } },
        });
        const truth: SquadTruth = {
          confirmed: finalAtt
            .filter((a) => a.status === "CONFIRMED")
            .map((a) => a.user.name ?? "(unnamed)"),
          bench: finalAtt
            .filter((a) => a.status === "BENCH")
            .map((a) => a.user.name ?? "(unnamed)"),
          maxPlayers: nextMatchForReply.maxPlayers,
          knownNames: memberships
            .map((m) => m.user.name)
            .filter((n): n is string => !!n),
        };
        const composedIdx: number[] = [];
        for (const i of candidates) {
          const out = composeSquadStateReply(results[i].reply!, truth);
          if (!out.composed) continue;
          results[i].reply = out.text;
          composedIdx.push(i);
        }
        // MatchTime posts ONE squad status per batch. Every composed
        // reply now renders the same post, so the earlier ones would be
        // literal duplicates — silence them, keeping the last (the
        // freshest message), exactly as the collapse did.
        for (const i of composedIdx.slice(0, -1)) results[i].reply = null;
        if (composedIdx.length > 0) {
          console.log(
            `[analyze] composed the squad status from the DB for ${composedIdx.length} repl${composedIdx.length === 1 ? "y" : "ies"}; ${composedIdx.length - 1} silenced`,
          );
        }
      }
    } catch (err) {
      console.error("[analyze] squad-status composition failed:", err);
    }
  }

  // ── RUN THE RECRUIT (verdict-driven, 2026-09-01) ────────────────────
  //   LAST, on purpose, and this ordering IS the fix.
  //
  //   Every attendance write in the batch has landed, and the batch-final
  //   squad-status collapse above has already re-canonicalised the roster
  //   text. Only now does the invite blast run, so it counts the squad
  //   the sender's own message just changed. On 2026-09-01 a regex ran it
  //   FIRST, against 10/10, and MatchTime told the owner his squad was
  //   full one line after he said Najib was out.
  //
  //   The action, its copy and the admin gate are the deleted fast path's,
  //   unchanged. What moved is WHEN it runs and WHO decided it was asked
  //   for. The reply is MERGED into the message's single existing result,
  //   never pushed as a second one: MatchTime replies once or not at all.
  if (recruitRequests.length > 0) {
    // Only the LAST request fires, mirroring the generate_teams_request
    // dedupe above. Two admins asking in one batch must not produce two
    // DM blasts to the same people.
    const { msg: recruitMsg, lookbackMatches } =
      recruitRequests[recruitRequests.length - 1];
    if (recruitRequests.length > 1) {
      console.log(
        `[analyze] ${recruitRequests.length} recruit requests in one batch — firing the last only`,
      );
    }
    try {
      const { inviteRecentPlayers } = await import("@/lib/recruit");
      // §10 step 8: the lookback the ADMIN asked for, already clamped to
      // `[1, 12]` by `admin-ops-engine.ts` against `recruit.ts`'s own
      // ceiling. Null when the ask did not name a number (and always,
      // for step 6's `sideRequests: ["recruit"]` shape, which carries no
      // number), in which case `inviteRecentPlayers` uses its default of
      // 5 — exactly what the shipped call did. A mass DM is how the
      // WhatsApp account gets banned, so the clamp is applied where the
      // number is read and re-applied by `resolveLookbackMatches` here.
      const r = await inviteRecentPlayers(org.id, lookbackMatches ?? undefined);
      const recruitReply = !r.ok
        ? r.reason ?? "Couldn't do that right now."
        : r.invited && r.invited > 0
          ? `📣 On it — DM'd ${r.invited} recent player${r.invited === 1 ? "" : "s"} who hadn't replied, asking them to fill *${r.matchName}*${r.need ? ` (${r.need} spot${r.need === 1 ? "" : "s"} left)` : ""}. I'll add anyone who taps in. 🙏`
          : r.reason
            ? r.reason // full-squad case: no open spots to recruit for.
            : r.alreadyInvited && r.alreadyInvited > 0
              ? // Branch 3: candidates existed but were ALL already pinged on a
                // previous recruit call — they just haven't replied yet.
                `Already pinged the recent players for *${r.matchName}* — just waiting on their replies. 🙏`
              : // Branch 2: genuinely nobody recent left to ask.
                `No new players to ask for *${r.matchName}* right now. 👍`;

      const idx = results.findIndex((x) => x.waMessageId === recruitMsg.waMessageId);
      if (idx >= 0) {
        // ONE reply. If the LLM already answered the attendance half, the
        // recruit line is appended to it; it is never a second send.
        results[idx].reply = mergeRecruitReply(results[idx].reply, recruitReply);
        results[idx].react = results[idx].react ?? "✅";
        if (
          results[idx].handledBy === "ignored" ||
          results[idx].intent === "noise" ||
          results[idx].intent === "unclear"
        ) {
          // The verdict itself carried nothing (a PURE recruit ask), so
          // the blast is the only thing that happened — label it as such.
          // "fast-path" still means "a deterministic server action, not
          // the model's words", which is exactly what this is; keeping the
          // old label leaves the admin log's vocabulary unchanged.
          results[idx].handledBy = "fast-path";
          results[idx].intent = "recruit_recent";
        }
      } else {
        // Defensive: every loop iteration pushes exactly one result, so
        // this is unreachable. Never drop the outcome if it ever isn't.
        results.push({
          waMessageId: recruitMsg.waMessageId,
          handledBy: "fast-path",
          intent: "recruit_recent",
          react: "✅",
          reply: recruitReply,
        });
      }
      await augmentAnalysis({
        waMessageId: recruitMsg.waMessageId,
        action: `recruit:${r.invited ?? 0}`,
        reasoningSuffix: `admin recruit — invited ${r.invited ?? 0} recent players`,
      });
    } catch (err) {
      console.error("[analyze] verdict-driven recruit failed:", err);
    }
  }

  // ── The marker is never posted to a group ───────────────────────────
  //   The prompt asks the model to end a squad-state reply with
  //   `[SQUAD]` and the composer above replaces it. The composer only
  //   runs when there IS a match to compose from, so a group with no
  //   upcoming match would otherwise read a literal "[SQUAD]". Last
  //   line of defence, applied to every result whatever produced it.
  for (const r of results) {
    if (!r.reply) continue;
    const stripped = stripSquadPostMarker(r.reply);
    if (stripped === r.reply) continue;
    r.reply = stripped.length > 0 ? stripped : null;
  }

  // ── INVARIANT: at most ONE result per message ───────────────────────
  //   MatchTime must never reply twice to one message. Every path above
  //   pushes exactly one result per waMessageId and the recruit merges
  //   into an existing one rather than appending; this is the backstop
  //   that says so out loud if a future path forgets.
  {
    const seenIds = new Set<string>();
    for (let i = results.length - 1; i >= 0; i--) {
      const id = results[i].waMessageId;
      if (seenIds.has(id)) {
        console.error(
          `[analyze] INVARIANT VIOLATION: duplicate result for ${id} — dropping the extra so the bot replies once`,
        );
        results.splice(i, 1);
        continue;
      }
      seenIds.add(id);
    }
  }

  // 3b. Backfill the registration-react on earlier duplicate IN messages
  //     from same author. State-collapse: when a player sends "count me
  //     in" then "IN" 30s later, the LLM only registers the latest
  //     (correct — no double-registration). But the earlier message
  //     gets a plain 👍 which looks like "not registered" and confuses
  //     people into retyping. If a later verdict for the same author
  //     registered them as IN (✅ or 🪑), propagate it back to the
  //     earlier IN verdicts so the chat reads cleanly.
  const registrationReacts = new Set(["✅", "🪑"]);
  const latestInReactByUser = new Map<string, string>();
  for (const r of results) {
    const uid = senderById.get(r.waMessageId)?.userId;
    if (!uid || r.intent !== "in" || !r.react) continue;
    if (registrationReacts.has(r.react)) latestInReactByUser.set(uid, r.react);
  }
  for (const r of results) {
    const uid = senderById.get(r.waMessageId)?.userId;
    if (!uid || r.intent !== "in" || !r.react) continue;
    if (registrationReacts.has(r.react)) continue;
    const fill = latestInReactByUser.get(uid);
    if (fill) r.react = fill;
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

  // ── THE SHADOW WINDOW-ANALYZER IS RETIRED (§10 step 7) ─────────────
  //
  //   "Migrate the rest… Retire the mega-prompt when the last route
  //    leaves. RETIRE THE SHADOW."
  //
  //   `runShadowAnalysis` fired here via `after()` on every batch: a
  //   second, entirely uncached `claude-sonnet-4-5` call over the same
  //   window, writing a `WindowVerdict` row for `/admin/shadow` to diff
  //   against the live per-message verdicts. §8.1 measured it at ~30% of
  //   the whole analyzer bill.
  //
  //   It was a COMPARISON, and it compared against the mega-prompt. With
  //   the mega-prompt deleted there is nothing on the other side of the
  //   diff: it would spend a Sonnet call per batch to produce a verdict
  //   no live path reads and no dashboard can contrast with anything.
  //   §7.1 is fair to it — "its infrastructure is exactly right and is
  //   the migration harness… building it was not wasted work; it was the
  //   previous step of this same journey" — and this is the journey
  //   arriving.
  //
  //   WHAT IS KEPT, deliberately:
  //     • the `WindowVerdict` TABLE and every historical row in it. Three
  //       months of shadow runs are a record of how this decision was
  //       reached and are not ours to delete.
  //     • `/admin/shadow`, which renders them.
  //     • `api/cron/none-bucket-shadow`, which writes NEW `WindowVerdict`
  //       rows and is a different mechanism entirely — §11.1's fourth
  //       containment, "shadow the `none` bucket forever… the regression
  //       detector the current architecture has never had". That one
  //       matters MORE after this change, not less: it is now the only
  //       thing watching for a real IN routed `none`.

  return NextResponse.json({
    ok: true,
    orgId: org.id,
    nextKickoffMs: nextMatch?.date.getTime() ?? null,
    results,
  });
}

/**
 * §9 "UNRESOLVED-SENDER NUDGE — SURVIVES".
 *
 * "Message understood, action silently not taken" is this product's
 * signature failure and is independent of who decides, so it is now
 * SHARED by both deciders rather than living inside the analyzer's
 * branch. §10 step 6 moves the attendance path to the engine; an
 * engine-decided message whose sender could not be resolved must reach
 * exactly the same nudge, with the same dedupe key, or turning the flag
 * on would quietly delete a guard.
 *
 * The rules are unchanged from the block this was lifted out of: fires
 * only for an unresolved sender on an attendance-relevant message with
 * a match to name; one nudge per pushname per match, forever; never
 * prints a raw numeric id as a name (RC4).
 *
 * `applies: false` means the caller keeps whatever reply it had.
 * `applies: true` with `reply: null` means "already nudged — say
 * nothing", which is deliberately not the same thing.
 */
async function unresolvedSenderNudge(args: {
  senderResolved: boolean;
  attendanceRelevant: boolean;
  matchId: string | null;
  authorName: string | null;
  dropping: boolean;
}): Promise<{ applies: boolean; reply: string | null }> {
  const { senderResolved, attendanceRelevant, matchId, authorName, dropping } = args;
  const pushname = (authorName ?? "").trim();
  if (senderResolved || !attendanceRelevant || !matchId || pushname.length < 1) {
    return { applies: false, reply: null };
  }
  const normKey = pushname
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  const dedupeKey = `unresolved-sender:${matchId}:${normKey}`;
  const already = await db.sentNotification.findUnique({ where: { key: dedupeKey } });
  if (already) {
    // Already nudged for this pushname+match — stay silent, don't
    // repeat. The admin queue still lists it.
    return { applies: true, reply: null };
  }
  // Plain English — describe what to DO next, no "resolver"/"@lid"/
  // "pushname" jargon (per the product copy rule).
  const verb = dropping ? "drop out" : "join";
  // Never print a raw numeric id as a name in the group (RC4).
  const reply = isRawDigitName(pushname)
    ? `Heads up — I got a message to *${verb}* from a number I don't recognise, ` +
      `so I haven't changed anything yet. Could they reply with the name they're ` +
      `registered under, or an admin can link it on the dashboard? 🙏`
    : `Heads up — I got a message to *${verb}* from *${pushname}*, but that name isn't ` +
      `matching anyone on the squad list, so I haven't changed anything yet. ` +
      `Could *${pushname}* reply with the name they're registered under, or an admin can link it on the dashboard? 🙏`;
  // Record the dedupe row immediately. Tiny risk: if the bot fails to
  // post we under-notify — acceptable, the admin queue is the backstop,
  // and re-nudging every batch would spam the group (the failure Kemal
  // hates most).
  await db.sentNotification.create({
    data: { key: dedupeKey, kind: "unresolved-sender-nudge", matchId },
  });
  return { applies: true, reply };
}

/**
 * Clear `leftAt` on a soft-removed membership when the player has
 * resurfaced in the chat. Preserves history (rating, attendance) and
 * silently re-activates them in the roster.
 */
async function restoreMembership(membershipId: string, name: string | null) {
  await db.membership.update({
    where: { id: membershipId },
    data: { leftAt: null, provisionallyAddedAt: null },
  });
  console.log(`[analyze] restored soft-removed membership ${membershipId} (${name ?? "unknown"})`);
}

/**
 * True when a "name" is really a raw phone number / numeric @lid id
 * ("447700900123", "123456789012@lid", "+44 7700 900123", "@4477…").
 * Never stamp these as display names or print them in group posts —
 * use a neutral placeholder and let an admin rename. (RC4 of the
 * 2026-06-12 Sutton Lads incident: a bare number showed up as a player
 * name in a group post.)
 */
function isRawDigitName(raw: string): boolean {
  const cleaned = raw
    .trim()
    .replace(/@?lid$/i, "")
    .replace(/[@\s+().-]/g, "");
  return /^\d{5,}$/.test(cleaned);
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
    // Include soft-removed memberships in the candidate set: someone
    // posting in the group is clearly back, so a unique match against a
    // soft-removed member should restore them rather than provision a
    // new ghost user. We track leftAt status per-candidate to apply the
    // restore on the chosen match.
    const candidates = await db.membership.findMany({
      where: { orgId },
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
      const m = equalsMatches[0];
      if (m.leftAt) await restoreMembership(m.id, m.user.name);
      return { userId: m.user.id, name: m.user.name, phone: null };
    }

    const firstNameMatches = candidates.filter((c) => {
      if (!c.user.name) return false;
      const dbTokens = norm(c.user.name).split(/\s+/).filter(Boolean);
      const dbFirst = dbTokens[0] ?? "";
      return (
        dbFirst === pushFirst ||
        // Relaxed prefix match: as long as one side is ≥3 chars and the
        // other is ≥2, accept a startsWith. Handles short pushnames like
        // "ba" → "Baki" and nicknames like "Kara" → "Karahan". The
        // uniqueness check above still blocks ambiguous cases ("Ed" when
        // both "Ediz" and "Edward" are in the org).
        ((dbFirst.length >= 3 && pushFirst.length >= 2 && dbFirst.startsWith(pushFirst)) ||
          (pushFirst.length >= 3 && dbFirst.length >= 2 && pushFirst.startsWith(dbFirst)))
      );
    });
    if (firstNameMatches.length === 1) {
      const m = firstNameMatches[0];
      if (m.leftAt) await restoreMembership(m.id, m.user.name);
      return { userId: m.user.id, name: m.user.name, phone: null };
    }
    // Multiple first-name matches (e.g. two Ibrahims) — try the alias
    // table FIRST before giving up. UserAlias is admin-curated
    // (populated by mergePlayers) and unique per (orgId, alias), so an
    // alias hit disambiguates cleanly regardless of how many fuzzy
    // candidates also match. Kemal flagged 2026-05-15: Baki's "ba"
    // pushname matches both Baki and Başar by fuzzy, so the resolver
    // returned null — but UserAlias["ba"] → Baki was already present
    // from an earlier merge, and it should have taken precedence.
    if (firstNameMatches.length > 1) {
      const aliasKeyEarly = norm(pushname);
      if (aliasKeyEarly.length >= 2) {
        const alias = await db.userAlias.findUnique({
          where: { orgId_alias: { orgId, alias: aliasKeyEarly } },
        });
        if (alias) {
          const m = candidates.find((c) => c.userId === alias.userId);
          if (m) {
            if (m.leftAt) await restoreMembership(m.id, m.user.name);
            console.log(
              `[analyze] ambiguous fuzzy "${pushname}" resolved via UserAlias → ${m.user.name} (${alias.userId})`,
            );
            return { userId: m.user.id, name: m.user.name, phone: null };
          }
        }
      }
      console.warn(
        `[analyze] ambiguous fuzzy match for "${pushname}" in org ${orgId} — ${firstNameMatches.length} candidates: ${firstNameMatches
          .map((m) => m.user.name)
          .join(", ")} (no alias to disambiguate)`,
      );
      return { userId: null, name: pushname, phone: null };
    }

    // Alias lookup. Admin merges populate UserAlias rows (Nunu →
    // Elnur Mammadov, etc.) so the next time the same pushname
    // arrives we resolve to the real user instead of creating
    // another ghost. Letter-overlap-based fuzzy could never bridge
    // "Nunu" → "Elnur" — admin curation is the right tool for
    // nicknames + privacy-mode pushnames.
    const aliasKey = norm(pushname);
    if (aliasKey.length >= 2) {
      const alias = await db.userAlias.findUnique({
        where: { orgId_alias: { orgId, alias: aliasKey } },
      });
      if (alias) {
        const m = candidates.find((c) => c.userId === alias.userId);
        if (m) {
          if (m.leftAt) await restoreMembership(m.id, m.user.name);
          return { userId: m.user.id, name: m.user.name, phone: null };
        }
      }
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
  // Never surface a raw numeric id as a display name — downstream
  // replies address the sender by this field.
  const fallbackName =
    msg.authorName && !isRawDigitName(msg.authorName) ? msg.authorName : null;
  return { userId: null, name: fallbackName, phone: null };
}

async function createProvisionalMember(
  orgId: string,
  msg: InboundMessage,
): Promise<ResolvedSender | null> {
  return createProvisionalByName(orgId, msg.authorName?.trim() ?? null, msg.authorPhone);
}

/**
 * Fuzzy-match a free-text name against the org's roster, or create a
 * provisional member if no unique match. Used for:
 *   - the message sender themselves (resolveSender fallback)
 *   - third-party registrations ("my dad Najib is also in" → lookup
 *     "Najib" in org, else provision)
 *
 * Returns null only when the name is empty / obviously not a person.
 */
async function resolveOrProvisionByName(
  orgId: string,
  rawName: string,
): Promise<{ userId: string; name: string | null } | null> {
  const name = rawName.trim();
  if (!name || name.length < 2) return null;

  // 1. Fuzzy lookup against existing members. Soft-removed members are
  //    INCLUDED in the candidate set so we restore them rather than
  //    creating a duplicate ghost when they get re-mentioned in chat.
  const candidates = await db.membership.findMany({
    where: { orgId },
    include: { user: { select: { id: true, name: true } } },
  });
  const norm = (s: string) =>
    s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const pushTokens = norm(name).split(/\s+/).filter(Boolean);
  const pushFirst = pushTokens[0] ?? "";

  const equalsMatches = candidates.filter(
    (c) => c.user.name && norm(c.user.name) === norm(name),
  );
  if (equalsMatches.length === 1) {
    const m = equalsMatches[0];
    if (m.leftAt) await restoreMembership(m.id, m.user.name);
    return { userId: m.user.id, name: m.user.name };
  }

  const firstNameMatches = candidates.filter((c) => {
    if (!c.user.name) return false;
    const dbTokens = norm(c.user.name).split(/\s+/).filter(Boolean);
    const dbFirst = dbTokens[0] ?? "";
    return (
      dbFirst === pushFirst ||
      (dbFirst.length >= 3 &&
        pushFirst.length >= 3 &&
        (dbFirst.startsWith(pushFirst) || pushFirst.startsWith(dbFirst)))
    );
  });
  if (firstNameMatches.length === 1) {
    const m = firstNameMatches[0];
    if (m.leftAt) await restoreMembership(m.id, m.user.name);
    return { userId: m.user.id, name: m.user.name };
  }
  // Ambiguous: multiple players match the given name ("Ibrahim" when
  // there are two). BEFORE bailing out, try the alias table — admin-
  // curated UserAlias rows are unique per (orgId, alias) so an alias
  // hit disambiguates cleanly regardless of fuzzy ambiguity. Same fix
  // as resolveSender (Kemal flagged Baki/"ba" 2026-05-15).
  if (firstNameMatches.length > 1) {
    const aliasKeyEarly = norm(name);
    if (aliasKeyEarly.length >= 2) {
      const alias = await db.userAlias.findUnique({
        where: { orgId_alias: { orgId, alias: aliasKeyEarly } },
      });
      if (alias) {
        const m = candidates.find((c) => c.userId === alias.userId);
        if (m) {
          if (m.leftAt) await restoreMembership(m.id, m.user.name);
          console.log(
            `[analyze] third-party ambiguous "${name}" resolved via UserAlias → ${m.user.name} (${alias.userId})`,
          );
          return { userId: m.user.id, name: m.user.name };
        }
      }
    }
    console.warn(
      `[analyze] third-party name "${name}" is ambiguous in org ${orgId} (${firstNameMatches.length} candidates, no alias to disambiguate). Skipping registration.`,
    );
    return null;
  }

  // 1c. Alias lookup — admin-curated nickname → user mapping. Same
  //     reason as resolveSender: covers "Nunu" → Elnur, "Mike" →
  //     Michael Allen, etc. that fuzzy can't bridge.
  const aliasKey = norm(name);
  if (aliasKey.length >= 2) {
    const alias = await db.userAlias.findUnique({
      where: { orgId_alias: { orgId, alias: aliasKey } },
    });
    if (alias) {
      const m = candidates.find((c) => c.userId === alias.userId);
      if (m) {
        if (m.leftAt) await restoreMembership(m.id, m.user.name);
        return { userId: m.user.id, name: m.user.name };
      }
    }
  }

  // 2. No unique match and no ambiguity → provision. No phone known (third party).
  const provisioned = await createProvisionalByName(orgId, name, null);
  if (provisioned) return { userId: provisioned.userId!, name: provisioned.name };
  return null;
}

async function createProvisionalByName(
  orgId: string,
  rawName: string | null,
  rawPhone: string | null,
): Promise<ResolvedSender | null> {
  const trimmed = rawName?.trim();
  // Never stamp a raw phone number / @lid numeric id as a display name
  // (RC4, 2026-06-12): provision under a neutral placeholder instead
  // and let the admin rename from the dashboard — the membership is
  // flagged provisional either way, and group posts must never show
  // bare digits as a player.
  const name = trimmed && isRawDigitName(trimmed) ? "New player" : trimmed;
  // Require ≥3 chars: 2-char pushnames like "ba" are almost always
  // truncations of a real name we already have (e.g. "Baki Sutton") and
  // provisioning them creates duplicate ghost users. The relaxed fuzzy
  // matcher (see firstNameMatches) now resolves short pushnames to
  // existing members; provisioning is reserved for genuinely new names.
  if (!name || name.length < 3) return null;
  // Skip obvious non-player authors (bot itself, group admin system messages).
  const blocked = /^(match time|matchtime|whatsapp|system)$/i;
  if (blocked.test(name)) return null;

  const normPhone = rawPhone
    ? normalisePhone(rawPhone.startsWith("+") ? rawPhone : `+${rawPhone}`)
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

// `KEYCAP` is deleted with `executeVerdict` (§10 step 8). The
// slot-number reactions it rendered are composed by
// `pipeline/compose.ts` from the projected position, so the emoji and
// the row it claims to describe are produced by the same pass and
// cannot disagree.

/**
 * Pick the right match for an attendance/bench mutation.
 *
 * Two evolutions of this rule:
 * - 2026-05-06: dropped the `attendanceDeadline > now` filter (was
 *   causing post-deadline cascade to NEXT WEEK silently). Now we
 *   only consider matches with date >= startOfToday.
 * - 2026-05-06 (later): block registrations while the most recent
 *   scheduled match hasn't been COMPLETED yet. Use case: yesterday's
 *   match has ended (~22:30) but the cron hasn't flipped its status
 *   to COMPLETED yet (~01:00 the next morning). During that window
 *   a player saying "in" should NOT silently register for next
 *   week's match — they're almost certainly still talking about
 *   yesterday's match. Registration only opens once the current
 *   match is COMPLETED.
 *
 * Rule:
 *   1. If any non-COMPLETED non-CANCELLED match has date < today,
 *      return null. The current scheduled match is in flight.
 *   2. Otherwise return the soonest non-completed match where
 *      date >= today.
 */
/**
 * The ACTIVE registration match — the single match every attendance WRITE
 * lands on. Delegates the date/state decision to the pure, unit-tested
 * `selectRegistrationMatch` so the rule (soonest upcoming, regardless of
 * fullness or attendanceDeadline; blocked while a previous match is still
 * in flight) is one source of truth shared with the LLM-context + reply
 * selectors below. Fixes the 2026-06-18 Sutton Lads rollover bug where a
 * FULL this-week match let casual "In"s land on next week's empty match.
 */
async function findRegistrationMatch(orgId: string) {
  // Load every non-completed match for the org (always a small set — the
  // cron completes finished matches). The pure selector then decides the
  // active match and the in-flight block deterministically.
  const candidates = await db.match.findMany({
    where: {
      activity: { orgId },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
    },
    orderBy: { date: "asc" },
  });
  const picked = selectRegistrationMatch(candidates);
  return picked ?? null;
}

// ── `executeVerdict` IS DELETED (§10 step 8) ─────────────────────────
//
//   921 lines, and the last thing in this file that took an
//   `AnalysisVerdict`. It was the model's output turned into database
//   writes and English, and §5 counted sixteen distinct overrides inside
//   it correcting that output on the way through.
//
//   Every branch it carried now has an owner that decides from FACTS and
//   composes from the DATABASE, and none of the moves is a
//   reimplementation from memory — each apply layer cites the lines it
//   was lifted from:
//
//     attendance IN/OUT/BENCH   → `lib/attendance-engine.ts` (step 6)
//     bench confirmation        → `lib/bench-prompt-answer.ts` +
//                                 `resolveBenchConfirmation`, peeled
//                                 deterministically before the router
//     conditional_in / tentative→ `pipeline/engine.ts`, from `contingent`
//                                 and `conditionOn` rather than a regex
//                                 that needed a literal "if" and so let
//                                 "happy to drop WHEN you find someone"
//                                 straight through (§9)
//     score + Elo               → `lib/score-engine.ts`, deps in
//                                 `lib/owner-deps.ts`
//     generate / show teams     → `lib/team-ops-engine.ts` and
//                                 `pipeline/answer-batch.ts`
//     bulk payment credit       → `lib/admin-ops-engine.ts`, deps in
//                                 `lib/owner-deps.ts`
//     reminder request          → `lib/admin-ops-engine.ts`, with the
//                                 calendar arithmetic in the pure
//                                 `lib/reminder-time.ts` instead of the
//                                 model's head (§3.2 S22)
//     the per-org feature gate  → each owner reads the org's features
//                                 out of its own `SquadState` load and
//                                 owns nothing when its feature is off,
//                                 which refuses BEFORE the write rather
//                                 than suppressing the reply after it
//
//   `KEYCAP` went with it: the slot-number reactions it rendered are
//   composed by `pipeline/compose.ts` from the projected position now,
//   and §3.2's category-E note records that the prompt rule forbidding
//   them was itself "an instruction whose entire content is the history
//   of a removed feature".

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
  /** WhatsApp pushname. Persisted so the admin "unresolved messages"
   *  queue can show WHO ("ba") to link to a player when authorUserId
   *  is null. */
  authorName?: string | null;
}) {
  try {
    await db.analyzedMessage.create({
      data: {
        waMessageId: args.msg.waMessageId,
        orgId: args.orgId,
        groupId: args.groupId,
        authorPhone: args.msg.authorPhone || null,
        authorUserId: args.authorUserId ?? null,
        authorName: args.authorName ?? args.msg.authorName ?? null,
        body: args.msg.body.slice(0, 2000),
        handledBy: args.handledBy,
        intent: args.intent,
        action: args.action,
        confidence: args.confidence,
        reasoning: args.reasoning.slice(0, 2000),
        // The flush this message was reasoned about in. Null outside a
        // batch (nothing else calls this) — see analyze-batch-context.ts.
        batchId: currentAnalyzeBatchId(),
      },
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    if (!/unique/i.test(m)) {
      console.error("[analyze] recordAnalysis failed:", err);
    }
  }
}

/**
 * Add an outcome to an AnalyzedMessage row that already exists.
 *
 * `AnalyzedMessage.waMessageId` is UNIQUE and `recordAnalysis` swallows
 * the unique violation, so a second create for the same message is
 * silently discarded — the first write wins. The verdict-driven recruit
 * runs AFTER the LLM path has already recorded the message, so it must
 * UPDATE rather than create, or the admin log would show the drop and no
 * trace of the invite blast that went out with it.
 *
 * Best-effort: a failure here must never fail the batch.
 */
async function augmentAnalysis(args: {
  waMessageId: string;
  action: string;
  reasoningSuffix: string;
}) {
  try {
    const existing = await db.analyzedMessage.findUnique({
      where: { waMessageId: args.waMessageId },
      select: { action: true, reasoning: true },
    });
    if (!existing) return;
    const action = existing.action ? `${existing.action}+${args.action}` : args.action;
    const reasoning = existing.reasoning
      ? `${existing.reasoning} | ${args.reasoningSuffix}`
      : args.reasoningSuffix;
    await db.analyzedMessage.update({
      where: { waMessageId: args.waMessageId },
      data: { action: action.slice(0, 2000), reasoning: reasoning.slice(0, 2000) },
    });
  } catch (err) {
    console.error("[analyze] augmentAnalysis failed:", err);
  }
}

/**
 * Archive inbound messages for a `featureSquadFromList` org so the
 * squad-extraction cron has raw data to diff. Skipped entirely for
 * other orgs (Sutton etc. don't write here). Idempotent on
 * waMessageId (unique). Body trimmed to 4 KB to be safe in case of
 * gigantic copy-pastes.
 */
async function storeMessagesForSquadFromList(
  orgId: string,
  groupId: string,
  messages: InboundMessage[],
): Promise<void> {
  if (!messages.length) return;
  // Filter empty bodies + the bot's own messages (no authorPhone +
  // no authorName) at the edge so we don't pollute the archive.
  const rows = messages
    .filter((m) => m.body.trim().length > 0)
    .map((m) => ({
      orgId,
      waChatId: groupId,
      waMessageId: m.waMessageId,
      senderPhone: m.authorPhone || null,
      senderPushname: m.authorName || null,
      body: m.body.slice(0, 4000),
      timestamp: new Date(m.timestamp),
    }));
  if (!rows.length) return;
  try {
    await db.groupMessage.createMany({ data: rows, skipDuplicates: true });
  } catch (err) {
    // Don't break the analyze response on archive failure — the
    // squad-extraction cron will try again next time the same messages
    // re-arrive (we already dedupe on waMessageId).
    console.error("[analyze] storeMessagesForSquadFromList failed:", err);
  }
}

/**
 * Phase 2 onboarding router. Returns a bot response object when this
 * batch belongs to an onboarding flow (active session, or a fresh
 * "@MatchTime setup" trigger in a group with no bot-enabled org), or
 * null to fall through to normal analysis.
 *
 * Trigger is intentionally tight so it can't fire by accident in a
 * live group: must address MatchTime AND say set up / get started.
 */
const SETUP_TRIGGER =
  /(?:@?\s*match\s*time\b[\s\S]{0,40}\b(?:set\s*up|get\s*started|onboard)\b)|(?:\b(?:set\s*up|onboard)\s+match\s*time\b)/i;

async function handleOnboardingIfApplicable(
  body: InboundBody,
): Promise<{ ok: true; results: ActionForBot[] } | null> {
  const groupId = body.groupId;

  let session = await db.onboardingSession.findFirst({
    // "introduced"/"details" are the Phase 1 group-add stages
    // (2026-06-12 design); they only ever exist when the flag-gated
    // /api/whatsapp/bot-added route created them, so this is inert for
    // every group that never went through a bot-add.
    where: {
      whatsappGroupId: groupId,
      stage: { in: ["collecting", "features", "introduced", "admins", "details"] },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!session) {
    // No active session — only start one on an explicit trigger AND
    // only if this group isn't already a live org (don't hijack a
    // configured group).
    const triggered = body.messages.some((m) => SETUP_TRIGGER.test(m.body || ""));
    if (!triggered) return null;
    const liveOrg = await db.organisation.findFirst({
      where: { whatsappGroupId: groupId, whatsappBotEnabled: true },
      select: { id: true },
    });
    if (liveOrg) return null; // already set up — ignore the trigger
    session = await db.onboardingSession.create({
      data: { whatsappGroupId: groupId, stage: "collecting" },
    });
  }

  // Dedupe: if the last message we already handled is the tail of
  // this batch, a flush re-sent it — stay silent.
  const lastWaId = body.messages[body.messages.length - 1]?.waMessageId ?? null;
  if (lastWaId && session.lastHandledWaId === lastWaId) {
    return { ok: true, results: [] };
  }

  const result = await handleOnboardingTurn({
    session,
    messages: body.messages.map((m) => ({
      waMessageId: m.waMessageId,
      authorName: m.authorName,
      body: m.body,
      // Sender identity — used by the group-add flow to capture the
      // consenting admin (design fix: this used to be dropped, so the
      // flow COULDN'T assign an owner even if it wanted to).
      authorPhone: m.authorPhone ?? null,
      // Raw WhatsApp mention JIDs, forwarded UNCHANGED from the bot. The
      // `admins` stage's parseAdmins() resolves "<digits>@c.us" → phone
      // and treats "<digits>@lid" as a privacy id (no phone).
      mentions: m.mentions,
    })),
    // Forward enrichment history (if any) to the onboarding turn; the
    // turn fires the enrichment pass + admin DM on completion. Absent →
    // no enrichment runs. Already in the HistoryMessage shape.
    history: body.enrichmentHistory,
  });

  const results: ActionForBot[] = [];
  if (result.reply && lastWaId) {
    results.push({
      waMessageId: lastWaId,
      handledBy: "llm",
      intent: "onboarding",
      react: null,
      reply: result.reply,
    });
  }
  return { ok: true, results };
}

/**
 * SEATBELT (2026-05-19): "swap A with B" / "switch A and B" where
 * BOTH are currently CONFIRMED is a TEAM swap — never a drop. We
 * resolve it deterministically from DB state and bypass the LLM
 * verdict so the "swap = X OUT" prompt rule can't fire.
 *
 * Returns:
 *   { reply, logReason }  → handled (caller skips executeVerdict)
 *   null                  → not a both-confirmed swap; let normal
 *                           flow handle it (a genuine replacement
 *                           where one side isn't playing is still a
 *                           legit attendance swap).
 */
/**
 * ── `looksLikeConditionalDrop` IS DELETED (§10 step 8) ───────────────
 *
 * The deterministic HOLD for "happy to drop if you can find someone"
 * (Kemal, 2026-06-09: Erdal was dropped on "If u can make happy to
 * drop"). It fired only when the model had already read the message as
 * a drop, and it decided contingency by looking for a literal `if`.
 *
 * §9 files it under "becomes a schema field", and names the hole the
 * regex had in its own words: it "requires a literal `if`, so 'happy to
 * drop WHEN you find someone' bypasses the hold entirely". The
 * extractor now returns `contingent` and `conditionOn` as FACTS about
 * the sentence, and `engine.ts` refuses to write a contingent claim
 * whatever conjunction it was phrased with. Corpus case
 * `S11-erdal-conditional-drop`.
 */

async function handleTeamSwapIfApplicable(
  orgId: string,
  rawBody: string,
): Promise<{ reply: string; logReason: string } | null> {
  const body = (rawBody || "").trim();
  // "swap A with B", "swap A and B", "switch A B", "swap A for B",
  // "swap A & B", "swap A, B". Names = letter runs (first names).
  const m = body.match(
    /\b(?:swap|switch)\s+([\p{L}'-]{2,})\s*(?:with|and|for|&|,|<->|>|\/)?\s*([\p{L}'-]{2,})/iu,
  );
  if (!m) return null;
  const n1 = m[1].toLowerCase();
  const n2 = m[2].toLowerCase();
  if (n1 === n2) return null;
  // Ignore obvious non-name tokens.
  const STOP = new Set(["the", "them", "him", "her", "with", "and", "for", "team", "teams", "side", "sides", "please", "pls"]);
  if (STOP.has(n1) || STOP.has(n2)) return null;

  const match = await db.match.findFirst({
    where: {
      activity: { orgId },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
    },
    orderBy: { date: "asc" },
    include: {
      activity: {
        include: {
          sport: { select: { teamLabels: true } },
          org: { select: { teamLabels: true } },
        },
      },
      attendances: {
        where: { status: "CONFIRMED" },
        include: { user: { select: { id: true, name: true } } },
      },
      teamAssignments: true,
    },
  });
  if (!match) return null;

  const norm = (s: string) =>
    s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const find = (q: string) => {
    const qq = norm(q);
    const cands = match.attendances.filter((a) => {
      if (!a.user.name) return false;
      const nm = norm(a.user.name);
      const first = nm.split(/\s+/)[0] ?? "";
      return nm === qq || first === qq || nm.startsWith(qq) || first.startsWith(qq);
    });
    return cands.length === 1 ? cands[0] : null;
  };
  const A = find(n1);
  const B = find(n2);
  // Both must resolve uniquely AND both be CONFIRMED for this to be a
  // TEAM swap. Otherwise it's not our case (could be a genuine
  // replacement, or ambiguous) — fall through to normal handling.
  if (!A || !B || A.user.id === B.user.id) return null;

  const labels = resolveTeamLabels(match, match.activity.org, match.activity.sport);
  const taA = match.teamAssignments.find((t) => t.userId === A.user.id);
  const taB = match.teamAssignments.find((t) => t.userId === B.user.id);

  if (!taA && !taB) {
    // Teams not generated yet — nothing to swap, but make ABSOLUTELY
    // sure nobody is dropped. Acknowledge + defer.
    return {
      reply:
        `Both *${A.user.name}* and *${B.user.name}* are already in — nobody's dropped. ` +
        `Teams aren't generated yet; say *generate teams* and I'll build them (then I can put them on opposite sides).`,
      logReason: `team-swap deferred (no teams yet): ${A.user.name} <-> ${B.user.name}`,
    };
  }

  // Swap their team sides (handle the one-sided edge defensively).
  const teamA = taA?.team ?? (taB?.team === "RED" ? "YELLOW" : "RED");
  const teamB = taB?.team ?? (taA?.team === "RED" ? "YELLOW" : "RED");
  await db.$transaction([
    db.teamAssignment.upsert({
      where: { matchId_userId: { matchId: match.id, userId: A.user.id } },
      create: { matchId: match.id, userId: A.user.id, team: teamB },
      update: { team: teamB },
    }),
    db.teamAssignment.upsert({
      where: { matchId_userId: { matchId: match.id, userId: B.user.id } },
      create: { matchId: match.id, userId: B.user.id, team: teamA },
      update: { team: teamA },
    }),
  ]);

  const fresh = await db.teamAssignment.findMany({
    where: { matchId: match.id },
    include: { user: { select: { name: true } } },
  });
  const red = fresh.filter((t) => t.team === "RED").map((t) => t.user.name);
  const yel = fresh.filter((t) => t.team === "YELLOW").map((t) => t.user.name);
  return {
    reply:
      `🔁 Swapped *${A.user.name}* and *${B.user.name}* — nobody dropped. Updated teams:\n\n` +
      `*${labels[0]}*\n${red.map((n, i) => `${i + 1}. ${n}`).join("\n")}\n\n` +
      `*${labels[1]}*\n${yel.map((n, i) => `${i + 1}. ${n}`).join("\n")}`,
    logReason: `team-swap applied: ${A.user.name} <-> ${B.user.name}`,
  };
}

/**
 * "swap/switch/flip the colours", "swap colors", "swap red and yellow" —
 * a request to flip the team LABELS while keeping the exact same player
 * groupings. Deterministic guard so it NEVER reaches the LLM's
 * generate_teams_request path, which rebalances into different teams
 * (Kemal 2026-06-09: "swap the colours and keep the same teams" ran a
 * full regen and produced different teams the night of a match). Returns
 * null when it isn't a colour swap or no teams exist yet — caller falls
 * through to normal handling.
 */
async function handleColorSwapIfApplicable(
  orgId: string,
  rawBody: string,
): Promise<{ reply: string; logReason: string } | null> {
  const body = (rawBody || "").trim();

  // Fast path: "swap/flip the colours" or "swap red and yellow" need no DB
  // lookup — the literal colour words / "colours" keyword are enough.
  const hasSwapVerb = /\b(swap|switch|flip|reverse|invert|change)\b/i.test(body);
  let isColourSwap =
    /\b(swap|switch|flip|reverse|invert|change)\b[\s\S]{0,40}\bcolou?rs?\b/i.test(body) ||
    /\bcolou?rs?\b[\s\S]{0,40}\b(swap|switch|flip|reverse|invert|change)\b/i.test(body) ||
    /\bswap\b[\s\S]{0,25}\b(red|yellow|reds|yellows)\b[\s\S]{0,25}\b(red|yellow|reds|yellows)\b/i.test(body);

  // Cheap pre-gate before touching the DB: only orgs with a swap verb in
  // the message can possibly be a "swap <labelA> and <labelB>" — anything
  // without a swap verb can't be a colour swap at all.
  if (!isColourSwap && !hasSwapVerb) return null;

  const match = await db.match.findFirst({
    where: {
      activity: { orgId },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
    },
    orderBy: { date: "asc" },
    include: {
      activity: {
        include: {
          sport: { select: { teamLabels: true } },
          org: { select: { teamLabels: true } },
        },
      },
      teamAssignments: { include: { user: { select: { name: true } } } },
    },
  });
  // No teams generated yet → nothing to flip; let normal handling decide.
  if (!match || match.teamAssignments.length === 0) return null;

  // Custom-label aware detection: if not already a literal red/yellow or
  // "colours" swap, recognise "swap <labelA> and <labelB>" using THIS org's
  // configured team labels (resolved from Organisation/Sport.teamLabels).
  // Red/Yellow stay covered by the regexes above as a fallback.
  if (!isColourSwap) {
    const cfgLabels = resolveTeamLabels(match, match.activity.org, match.activity.sport);
    const labelAlts = cfgLabels
      .map((l) => l.trim())
      .filter((l) => l && !/^(red|yellow)$/i.test(l))
      .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (labelAlts.length === 2) {
      const alt = `(?:${labelAlts.join("|")})`;
      const labelSwap = new RegExp(
        `\\bswap\\b[\\s\\S]{0,25}${alt}[\\s\\S]{0,25}${alt}`,
        "i",
      );
      if (labelSwap.test(body)) isColourSwap = true;
    }
    if (!isColourSwap) return null;
  }

  // Flip every assignment RED<->YELLOW in one transaction — same rosters,
  // labels swapped. No rebalance, no LLM.
  await db.$transaction(
    match.teamAssignments.map((t) =>
      db.teamAssignment.update({
        where: { id: t.id },
        data: { team: t.team === "RED" ? "YELLOW" : "RED" },
      }),
    ),
  );

  const labels = resolveTeamLabels(match, match.activity.org, match.activity.sport);
  const fresh = await db.teamAssignment.findMany({
    where: { matchId: match.id },
    include: { user: { select: { name: true } } },
  });
  const red = fresh.filter((t) => t.team === "RED").map((t) => t.user.name);
  const yel = fresh.filter((t) => t.team === "YELLOW").map((t) => t.user.name);
  return {
    reply:
      `🎨 Swapped the colours — same teams, sides flipped:\n\n` +
      `*${labels[0]}*\n${red.map((n, i) => `${i + 1}. ${n}`).join("\n")}\n\n` +
      `*${labels[1]}*\n${yel.map((n, i) => `${i + 1}. ${n}`).join("\n")}`,
    logReason: `colour-swap applied (labels flipped, rosters unchanged)`,
  };
}
