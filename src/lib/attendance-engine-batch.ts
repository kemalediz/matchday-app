/**
 * §10 STEP 6 — THE ATTENDANCE PATH, END TO END.
 *
 *   router → extractor → engine → APPLY → composer
 *
 * for the FOUR routes it owns — `self_att`, `other_att`, `offer` and,
 * since §10 step 8, `unsure` — and for nothing else. Everything the
 * router calls `none` is step 5's business, and the rest have owners of
 * their own: `question` and `balancer`(show) go to
 * `pipeline/answer-batch.ts`, `balancer`(generate) to
 * `team-ops-engine-batch.ts`, `score` to `score-engine-batch.ts`,
 * `admin_ops` to `admin-ops-engine-batch.ts`.
 *
 * WHAT STOOD HERE UNTIL 2026-09-06, and it was accurate for as long as
 * there was something standing behind this file:
 *
 *   "for the three routes step 6 owns (`self_att`, `other_att`,
 *    `offer`) and for nothing else. Everything the router calls
 *    `question`, `balancer`, `score`, `admin_ops` or `unsure` still
 *    reaches the 18,315-token prompt unchanged"
 *
 * §10 step 8 deleted `analyzeBatch`, the 19,850-token `SYSTEM_PROMPT`
 * and `executeVerdict`. `unsure` joined `ENGINE_ROUTES` in the same
 * change; `pipeline/gate.ts` carries the argument, and the short form is
 * that the question `unsure` asks stopped being "engine or analyzer" and
 * became "engine or SILENCE".
 *
 * ─────────────────────────────────────────────────────────────────────
 * IT STILL OWNS NOTHING RATHER THAN GUESSING. "OWNS NOTHING" NOW MEANS
 * SILENCE, AND THAT IS A BEHAVIOUR CHANGE — SAY SO
 * ─────────────────────────────────────────────────────────────────────
 * Every row of the table below used to end "→ the analyzer decides this
 * message", under the heading FAIL OPEN, ALWAYS and the reassurance
 * "which is today's behaviour and therefore cannot be a regression".
 * Every clause of that rested on the analyzer existing. It does not.
 *
 * A message this file declines is now claimed by NOBODY, and the analyze
 * route's "NOBODY OWNED IT" branch (`route.ts:1664`) gives it three
 * things: SILENCE in the group, an `AnalyzedMessage` row so the loss is
 * a query rather than an absence, and one line on a deduped operator DM
 * (`lib/operator-note.ts`). It is not a fail-open any more. It is a
 * fail-quiet with a receipt.
 *
 * §11.5 accepted that loss in advance and in these words: "a router with
 * nine routes and an engine with explicit rules will do nothing
 * instead… the club will experience it as 'the bot got dumber' before
 * they experience it as 'the bot stopped being wrong'." Calling it "not
 * a regression" would be the comfortable lie. It IS one; it was chosen
 * knowingly; the operator note is the whole of what makes it survivable.
 *
 *   • `enabled: false`                     → owns nothing → SILENCE +
 *                                            operator note. No env var
 *                                            reaches this any more; see
 *                                            the argument on the field.
 *   • no active registration match         → owns nothing → SILENCE +
 *                                            note
 *   • attendance is off for the org        → owns nothing → SILENCE.
 *                                            Whether an operator note
 *                                            fires depends on the org's
 *                                            OTHER features, and the
 *                                            honest answer is "it
 *                                            depends": a group with no
 *                                            message-driven feature at
 *                                            all returns before the
 *                                            pipeline (`route.ts:346`)
 *                                            and no note is possible,
 *                                            while an attendance-off,
 *                                            stats-Q&A-on group still
 *                                            reaches the unowned branch
 *                                            and DOES get one.
 *                                            `operator-note.ts`'s header
 *                                            says the caller filters
 *                                            org-excluded messages out
 *                                            before composing; on this
 *                                            axis it does not. Left
 *                                            alone and reported rather
 *                                            than quietly changed —
 *                                            step 8 is a deletion, not a
 *                                            place to invent new
 *                                            suppression rules.
 *   • the router never mentioned the id    → owns nothing (`undefined`
 *                                            is not a route) → SILENCE +
 *                                            note
 *   • an open bench prompt for the sender  → owns nothing for them. A
 *                                            plain yes/no was already
 *                                            answered by the
 *                                            deterministic peel above
 *                                            the pipeline; anything else
 *                                            is SILENCE + note. See the
 *                                            carve-out below.
 *   • a pasted roster                      → owns nothing; the peel
 *                                            above the pipeline handled
 *                                            it. See the carve-out.
 *   • the state load throws                → owns nothing → SILENCE +
 *                                            note
 *   • an extractor call throws TWICE       → THAT MESSAGE degrades, is
 *                                            reported, and goes SILENT.
 *                                            `extractors.ts` retries
 *                                            once first, on these four
 *                                            routes only, and that retry
 *                                            is what step 8 bought in
 *                                            place of the analyzer.
 *   • the engine throws                    → owns nothing → SILENCE +
 *                                            note, and deliberately NO
 *                                            retry: `decide()` is pure,
 *                                            so the same input throws
 *                                            again.
 *
 * OWNERSHIP IS STILL DECIDED BEFORE ANYTHING SPEAKS, and the reason
 * outlived the thing it was originally about. It used to read: "the
 * route has to know which ids to leave out of `analyzeBatch`, and asking
 * the mega-prompt about a message the engine is also going to decide
 * would mean two deciders and two replies for one message". There is no
 * mega-prompt — but there are FIVE owners now, and `route.ts`'s
 * `ownerOf` map asserts the very same invariant across all of them: one
 * owner per message, MatchTime replies once or not at all. The engine
 * still runs FIRST and its writes still land FIRST, so the other owners
 * reason about the world those writes made. The explicit attendance
 * instructions are applied before anything reasons about the squad.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE ENGINE SEES THE WHOLE WINDOW
 * ─────────────────────────────────────────────────────────────────────
 * Only owned messages are extracted, but EVERY message in the batch is
 * handed to `decide()`. Two rules depend on it and both are §9
 * survivors:
 *
 *   • the banter-drop guard corroborates against the target's own
 *     message in the same window (2026-06-12, Zeeshan);
 *   • the state collapse only lets an author's LATEST writing message
 *     write.
 *
 * A message the engine does not own arrives with `facts: {kind:"none"}`
 * and produces a `noop` outcome with a reason, which is what
 * `assertCoverage` requires and what keeps "exactly one outcome per
 * message" true across the split.
 */
import type { AttendanceWriteFailure } from "./attendance-write-outcome";
import { parsePastedRoster } from "./pasted-roster";
import { extractForRoute } from "./pipeline/extractors";
import { extractorStubFromEnv } from "./pipeline/extractor-stub";
import { anthropicModel, type PipelineModel } from "./pipeline/llm";
import { compose } from "./pipeline/compose";
import { decide } from "./pipeline/engine";
import { engineOwnsRoute } from "./pipeline/gate";
import { loadSquadState } from "./pipeline/load-state";
import type {
  AttendanceFacts,
  EngineMessage,
  EngineResult,
  Facts,
  Route,
  SquadState,
} from "./pipeline/types";
import {
  ENGINE_APPLY_DEGRADED_PREFIX,
  analyzedActionFor,
  applyEngineWrites,
  type EngineActor,
  type EngineApplyDeps,
  type EngineAttendanceWrite,
  type EngineWriteResult,
} from "./attendance-engine";

export interface EngineBatchMessage {
  waMessageId: string;
  body: string;
  authorName: string | null;
  senderUserId: string | null;
  senderName: string | null;
  senderIsAdmin: boolean;
  tagged: boolean;
  /** From the router. `undefined` when it never mentioned this id. */
  route: Route | undefined;
  /** Did step 5's gate skip this message? Then step 6 never sees it. */
  gated: boolean;
}

/** What the route needs in order to turn one owned message into exactly
 *  one `ActionForBot` and one `AnalyzedMessage` row. */
export interface EngineMessageOutcome {
  waMessageId: string;
  route: Route;
  reply: string | null;
  react: string | null;
  /** `AnalyzedMessage.intent`. Vocabulary the admin log already
   *  understands, derived from what HAPPENED, never from a model. */
  intent: string;
  /** `AnalyzedMessage.action`, from the writes that landed. */
  action: string;
  /** Machine reasons, one per rule that fired. Never prose for a regex
   *  to parse — nothing in this codebase parses it, and step 6 is the
   *  step that deletes the things that used to. */
  reasoning: string;
  /** Writes that THREW, for the honest ack. */
  failures: AttendanceWriteFailure[];
  /** The sender's own row moved, so the post-batch react audit should
   *  reconcile this react against the database. */
  senderOwnRowMoved: boolean;
  /** An admin asked for a replacement in this same message (PR #33). */
  recruitRequest: boolean;
  /** Personal-uncertainty conditional: record a MAYBE and chase later
   *  (`tentative-followup.ts`). Preserved from `executeVerdict`, which
   *  was itself deleted in §10 step 8 — this path is now the only one
   *  that records a tentative from a group message. */
  recordTentativeForUserId: string | null;
  /** A firm IN/OUT answers any open tentative follow-up. */
  resolveTentativeForUserId: string | null;
}

export interface EngineBatchResult {
  ownedIds: Set<string>;
  outcomes: Map<string, EngineMessageOutcome>;
  /** Attached to the LAST owned message that acted, so the batch has
   *  one squad post and it goes through the batch-final composition and
   *  collapse §10 step 4 built. (It used to say "the same … as the
   *  analyzer's"; there is no analyzer's any more — step 4's pass is the
   *  only one, and every owner now shares it.) */
  squadPostForMessageId: string | null;
  matchId: string | null;
  degradations: string[];
  cost: { usd: number; calls: number; ms: number };
}

/**
 * WHAT THE ENGINE DID, AND WHAT IT LOST, as lines for the operator.
 *
 * Pure and exported for one reason: the SELECTION of these lines was
 * wrong, and silently so. The analyze route composed them behind
 * `if (engineOwnedIds.size > 0)`, which silences them in exactly the
 * case they exist for — a batch where EVERY extraction failed ends with
 * `ownedIds` empty, and `empty(degradations)` above goes out of its way
 * to carry the reasons through that early return precisely so they could
 * be printed. One `&&` upstream threw them away, and a batch that had
 * just lost its whole extraction to an overloaded API read exactly like
 * a batch where the flag was off.
 *
 * A condition that can be wrong that quietly is a condition that belongs
 * in a unit test, not in a 2,600-line route handler.
 */
export function describeEngineBatch(
  batch: EngineBatchResult,
  batchSize: number,
): { warns: string[]; info: string | null } {
  const warns = batch.degradations.map((d) => `[analyze] attendance-engine degraded: ${d}`);
  // Silence only when there is genuinely nothing to say: the engine
  // owned nothing AND lost nothing, which is the flag being off or a
  // batch of pure banter.
  const info =
    batch.ownedIds.size > 0 || batch.degradations.length > 0
      ? `[analyze] attendance-engine: decided ${batch.ownedIds.size}/${batchSize} message(s) ` +
        `on match ${batch.matchId}, ` +
        `$${batch.cost.usd.toFixed(5)} across ${batch.cost.calls} extractor call(s) ` +
        `in ${batch.cost.ms}ms`
      : null;
  return { warns, info };
}

/**
 * "The engine owns nothing." That used to be followed by "; the analyzer
 * keeps the batch", and it was a complete sentence about where the batch
 * went. Since §10 step 8 nothing keeps it: every message in this result
 * reaches `route.ts:1664` unowned, says nothing to the group, and gets
 * one line on the operator DM.
 *
 * A FUNCTION, not a shared const. The result carries a `Set` and a
 * `Map`, and a single frozen-by-convention instance handed to every
 * caller is one `.add()` away from one request's state leaking into
 * the next. Cheap to build, and it takes the accumulated degradations so
 * a decline never loses the reason it happened. That argument got
 * STRONGER on 2026-09-06: those lines are handed to
 * `composeOperatorNote` as `degradations` and are the only source of the
 * "— why" clause on each bullet of the admin DM. Drop them and the
 * operator is told a message was lost but not what lost it.
 */
function empty(degradations: string[] = []): EngineBatchResult {
  return {
    ownedIds: new Set(),
    outcomes: new Map(),
    squadPostForMessageId: null,
    matchId: null,
    degradations,
    cost: { usd: 0, calls: 0, ms: 0 },
  };
}

export interface EngineBatchDeps extends EngineApplyDeps {
  /** Users with an unresolved bench prompt open on the active match.
   *  See the carve-out below. */
  openBenchPromptUserIds: (matchId: string) => Promise<string[]>;
  /** Injected so tests can drive the whole batch without a key. */
  model?: PipelineModel;
  /** Injected so tests can load a state without a database. */
  loadState?: (orgId: string, now: Date) => Promise<SquadState>;
}

export async function runAttendanceEngineBatch(args: {
  orgId: string;
  now: Date;
  messages: EngineBatchMessage[];
  history: Array<{ author: string | null; body: string }>;
  /**
   * The match the ROUTE believes registration lands on
   * (`findRegistrationMatch`). The engine's own loader picks the active
   * match with the same pure selector but from a 30-day window, so the
   * two can only disagree on a match that has been in flight for over a
   * month — and if they ever do, the engine owns nothing rather than
   * writing to a different match than the rest of the request is
   * describing.
   */
  expectedMatchId: string | null;
  /**
   * REQUIRED SINCE §10 STEP 8, AND ALWAYS `true` IN PRODUCTION.
   *
   * It used to be optional and default to `isAttendanceEngineEnabled()`,
   * i.e. `ATTENDANCE_ENGINE_ENABLED`, "so no caller can accidentally get
   * an engine it did not ask for". That flag is DELETED
   * (`pipeline/gate.ts` carries the argument): its off position meant
   * "the analyzer handles attendance instead", and with `analyzeBatch`
   * gone it would have meant nobody handles attendance at all - a kill
   * switch for the product's core write path wearing the name of a
   * tuning flag. There is no env var behind this any more and no default
   * to fall back to, so the caller must say what it wants.
   *
   * WHAT IT IS STILL FOR: `__tests__/attendance-engine-batch.test.ts`
   * passes it explicitly, and "run nothing" must stay expressible
   * without deleting the call site.
   */
  enabled: boolean;
  deps: EngineBatchDeps;
}): Promise<EngineBatchResult> {
  const { orgId, now, messages, history, expectedMatchId, deps } = args;
  if (!args.enabled) return empty();

  const candidates = messages.filter((m) => !m.gated && engineOwnsRoute(m.route));
  if (candidates.length === 0) return empty();

  const degradations: string[] = [];
  const t0 = Date.now();

  let state: SquadState;
  try {
    state = await (deps.loadState ?? loadSquadState)(orgId, now);
  } catch (err) {
    // Owning nothing. Until 2026-09-06 that was a fail-OPEN — "the
    // analyzer decides, which is what happens today" — and since §10
    // step 8 it is a fail-QUIET: every attendance message in this batch
    // goes unanswered and lands on the operator note. Still the right
    // call (a squad state we could not read is not one to write against)
    // but it is a real outage of the write path, not a shrug, so it is
    // logged as an error and every id in the batch reaches
    // `route.ts:1664`.
    console.error(
      "[attendance-engine] state load failed; NOBODY handles this batch — every attendance " +
        "message in it goes silent and onto the operator note:",
      err,
    );
    return empty();
  }

  // ── The carve-outs, all in the "own nothing" direction ─────────────
  if (!state.features.attendance) return empty();
  if (!state.matchId) {
    // No active registration match.
    //
    // What stood here until 2026-09-06: "The analyzer's
    // `findRegistrationMatch` would return null too and `executeVerdict`
    // would do nothing, so the outcome is the same either way — but it
    // is the analyzer's silence, with its reply and its
    // `AnalyzedMessage` row, rather than a second kind of silence nobody
    // has seen before."
    //
    // The premise (both deciders reach the same match, so both do
    // nothing) is still true and is still why this is safe. The
    // consolation is not: there is no analyzer's silence to inherit, so
    // this IS the second kind. What survives of the old comfort is the
    // half that mattered — the `AnalyzedMessage` row is still written,
    // by `route.ts:1664` rather than by `executeVerdict`, so a message
    // lost to "no match yet" is still a query.
    return empty();
  }
  if (expectedMatchId !== null && state.matchId !== expectedMatchId) {
    console.warn(
      `[attendance-engine] the route's registration match (${expectedMatchId}) and the ` +
        `engine's (${state.matchId}) disagree; owning nothing`,
    );
    return empty();
  }
  const matchId = state.matchId;

  // A bench player answering an open bench PROMPT in the group is
  // `resolveBenchConfirmation`'s business — a different table
  // (`PendingBenchConfirmation`) and a different flow from the
  // `BenchSlotOffer` the engine models. The engine has no concept of it,
  // so it owns nothing from a sender with a prompt open. THE RATIONALE
  // IS UNCHANGED; ONLY ITS LAST CLAUSE IS.
  //
  // It used to end "a bare 'yes' from someone with a prompt open stays
  // with the analyzer. Narrow, provable, and in the safe direction: it
  // costs one analyzer call." §10 step 8 deleted the analyzer and moved
  // the behaviour UP instead of losing it: `route.ts:811-880` peels the
  // bench-prompt answer before the pipeline runs, reading a whole-message
  // yes/no with `lib/bench-prompt-answer.ts` and calling
  // `resolveBenchConfirmation` directly. No model is in that loop at all.
  //
  // So the honest version of the last clause: a bare "yes" was already
  // answered before this file saw it, and costs nothing. What is NOT
  // free is the rest of the carve-out — this filter excludes EVERY
  // message from a prompted sender, and the peel only recognises a plain
  // yes/no, so "yeah go on then, but I'll be 10 mins late" is answered
  // by neither. That message now goes silent with an operator note. It
  // is a narrower loss than owning it wrongly would be, and it is a
  // loss.
  let promptedUserIds = new Set<string>();
  try {
    promptedUserIds = new Set(await deps.openBenchPromptUserIds(matchId));
  } catch (err) {
    console.error("[attendance-engine] bench-prompt lookup failed; owning nothing:", err);
    return empty();
  }

  const owned = candidates.filter((m) => {
    if (m.senderUserId && promptedUserIds.has(m.senderUserId)) return false;
    // ── PR #39's pasted-roster clamp is NOT reimplemented here ───────
    //
    // A pasted numbered roster is a message shape with its own solved
    // handling in the analyze route: `reconcilePastedRoster` computes
    // the appended names ARITHMETICALLY when the paste restates our own
    // roster post (S26), and `clampRosterDerivedWrites` registers
    // NOBODY off any other list. That exists because PR #35's
    // self-replay measured the same paste registering a DIFFERENT
    // SUBSET on each run — `Nabeel` one time, `Adam, Amir, Ehtisham,
    // Martin` the next.
    //
    // The engine has no equivalent, and a fourteen-line roster routed
    // `other_att` is fourteen third-party IN claims it would happily
    // apply. Rather than reimplement a shipped guard on the one step
    // that can put a player at a pitch with no slot, the shape is
    // simply not owned. The test is on the SHAPE and never on who is
    // named, so it cannot be steered by content.
    //
    // WHERE IT GOES INSTEAD, corrected 2026-09-06. This used to read
    // "it goes to the analyzer, where both rules already run", and that
    // was true until §10 step 8 deleted the analyzer. The refusal is
    // only safe while SOMETHING still applies the two rules, so step 8
    // moved them out rather than losing them:
    // `lib/pasted-roster-registration.ts` is a pure module carrying
    // `reconcilePastedRoster`'s arithmetic and `clampRosterDerivedWrites`'s
    // outcome, and `route.ts:909` peels the shape BEFORE the router
    // runs. Read that module's header for the one behaviour that DID
    // change — the `offList` residue, "here's the list, also adding
    // Kieran", is gone with `verdict.registerFor`.
    if (parsePastedRoster(m.body)) return false;
    // ── A SHARED CONTACT CARD IS NOT AN ATTENDANCE MESSAGE ───────────
    //
    // Found by the §10 step 6 replay sweep, adjudicated `old_right`:
    //
    //   2026-06-11, Ehtisham Ul Haq — a forwarded WhatsApp vCard
    //   (`BEGIN:VCARD … FN:Salman Shelly Ftbl … END:VCARD`) followed by
    //   "Add these 2 boys pl". The engine registered a member literally
    //   called "Salman Shelly Ftbl" — the card's display name, football
    //   suffix and all — and registered ONE of the two people asked
    //   for. The incumbent wrote nothing. Production labelled both
    //   messages `noise`.
    //
    // The card's `FN:` line looks exactly like a name to an extractor
    // and passes every check in `identity.ts`, because it IS letters and
    // it IS a person. What makes it wrong is the CONTAINER: a vCard is
    // an attachment WhatsApp renders as text, its display name is
    // whatever the sender saved in their phone, and "add these 2 boys"
    // beside it is `bring_guests_vague` (§3.2 S20) — a guest-name ask,
    // never a registration.
    //
    // Shape, not content: the test is the envelope, so it cannot be
    // steered by who the card names.
    //
    // (2026-09-06: unlike the pasted roster above, this shape has NO
    // deterministic peel and never had one. Refusing it now means
    // silence plus an operator note, where before it meant the analyzer
    // looked. That is the correct trade — the incumbent "wrote nothing"
    // on the real incident above, so the note is strictly more than the
    // analyzer gave — but it is a change, and this is where it is
    // recorded.)
    if (/^BEGIN:VCARD/im.test(m.body)) return false;
    return true;
  });
  if (owned.length === 0) return empty();
  const ownedIds = new Set(owned.map((m) => m.waMessageId));

  // ── Stage 2: extractors, in parallel ───────────────────────────────
  const model = deps.model ?? extractorStubFromEnv() ?? anthropicModel();
  // MatchTime's own last post, from the HISTORY the Pi forwards on every
  // call, falling back to the last queued group `BotJob` that
  // `loadSquadState` read.
  //
  // The history wins because it is what actually appeared in the group:
  // a `BotJob` is a queued send, and a group whose last post predates
  // the buffer window has an empty one. §3.2 S25's whole mechanism is
  // that the bot's last post is a KNOWN OBJECT, so a bare "Confirmed"
  // is a lookup rather than an inference — and with the wrong object it
  // is neither. Measured: corpus case
  // `S25-short-confirm-after-pending-list` went 3/3 → 0/3 ("expected
  // MatchTime to say something; it was silent") because the pending
  // list was in the history and `state.lastBotPost` was null.
  //
  // It feeds BOTH the extractor's context block and the engine's
  // `parsePendingSet`, which must agree or the two stages resolve the
  // same "Confirmed" against different posts.
  const lastBotPost =
    [...history].reverse().find((h) => (h.author ?? "").toLowerCase() === "matchtime")?.body ??
    state.lastBotPost ??
    null;
  state = { ...state, lastBotPost };

  let cost = { usd: 0, calls: 0, ms: 0 };
  const factsById = new Map<string, { facts: Facts; degraded: string | null }>();
  await Promise.all(
    owned.map(async (m) => {
      const res = await extractForRoute(model, m.route as Route, {
        id: m.waMessageId,
        body: m.body,
        authorName: m.authorName,
        tagged: m.tagged,
        history,
        lastBotPost,
      });
      for (const d of res.degradations) degradations.push(`extractor ${m.waMessageId}: ${d.detail}`);
      if (res.usage) {
        cost = {
          usd: cost.usd + (res.usage.costUsd ?? 0),
          calls: cost.calls + 1,
          ms: Math.max(cost.ms, res.usage.ms),
        };
      }
      // An extractor that FAILED (as opposed to one that found nothing)
      // must not become silence.
      const failure = res.degradations.find((d) => /failed|could not be parsed/i.test(d.detail));
      factsById.set(m.waMessageId, {
        facts: res.facts,
        degraded: failure ? failure.detail : null,
      });
    }),
  );

  // ── A FAILED EXTRACTION GOES SILENT, PER MESSAGE. SAY IT PLAINLY. ──
  //
  // §11.4 says "on extractor failure, fail closed and surface it".
  // Closed here means SILENT: no write, no reply, and a player who said
  // IN is not in the squad. Measured on the first live corpus sweep of
  // this step: 27 `529 Overloaded` and 3 `500`s across 10 messages,
  // which took S8 and S13b from 3/3 to 0/3 — not because the engine
  // decided them wrongly but because it never got to decide them at all.
  //
  // WHAT STOOD HERE UNTIL 2026-09-06, under the heading "A FAILED
  // EXTRACTION FALLS BACK TO THE ANALYZER, PER MESSAGE":
  //
  //   "The engine is one of TWO deciders and the other one is the
  //    incumbent, with every seatbelt still around it. So a message
  //    whose extraction failed is simply not owned: it goes back into
  //    `batchInputs` and the 18,315-token prompt handles it, exactly as
  //    it does today. That is the step's own revert — 'flag flips the
  //    three routes back' — applied per message and automatically, and
  //    it costs one analyzer call."
  //
  // There is no second decider. §10 step 8 deleted `analyzeBatch`, the
  // 19,850-token `SYSTEM_PROMPT` and `executeVerdict`, so an unowned
  // message is not handed on — it is DROPPED: silence in the group, an
  // `AnalyzedMessage` row, and one line on the operator DM
  // (`route.ts:1664`, `lib/operator-note.ts`). A "529 Overloaded" on a
  // bare "in" now costs that player their slot until somebody reads the
  // note. That is the sharpest edge in the whole redesign and it is not
  // dressed up as anything else.
  //
  // WHAT STEP 8 BOUGHT IN ITS PLACE, because the loss above was not
  // accepted for free: `extractors.ts` retries ONCE, on these four
  // routes only, before it ever reports a failure here. Measured, two
  // full SDK ladders against a genuinely overloaded API is 13.4s against
  // 13.1s for one — a rescue at almost no latency, on exactly the routes
  // where silence costs a slot. By the time an id reaches this block the
  // extractor has already tried twice, which is why its degradation says
  // "failed TWICE".
  const failedIds = new Set(
    [...factsById.entries()].filter(([, v]) => v.degraded).map(([id]) => id),
  );
  if (failedIds.size > 0) {
    for (const id of failedIds) {
      const detail = factsById.get(id)?.degraded ?? "unknown";
      // AN OPERATOR READS THIS LINE, ON THEIR PHONE, DURING AN INCIDENT.
      // `composeOperatorNote` puts the clause after the id onto the DM
      // as the "why" for this message, so it has to be true. Until
      // 2026-09-06 it said "handing this message back to the analyzer",
      // which by then named a deleted function and told the reader the
      // message was safe.
      degradations.push(
        `${ENGINE_APPLY_DEGRADED_PREFIX} ${id}: ${detail} — nobody handles this message: ` +
          `no reply in the group, and it is on this note`,
      );
    }
    // THE RATE, not just the count. PR #44 raised `maxRetries` to 4 and
    // the corpus sweep's ten lost messages went to zero, and
    // `extractors.ts` has added an application-level retry on top of
    // that. So the question an operator has is "how often is this
    // actually firing?", and a bare count cannot answer it while a count
    // over the batch's owned population can. Same line whether one
    // message failed or all of them did.
    //
    // The second half of this line was `those messages go to the
    // analyzer instead of going silent`, which after step 8 stated the
    // exact opposite of what happens.
    const rate = ((failedIds.size / owned.length) * 100).toFixed(1);
    console.warn(
      `[attendance-engine] ${failedIds.size} of ${owned.length} extraction(s) failed twice (${rate}%); ` +
        `those messages go SILENT — nobody else handles them, and each is on the operator note`,
    );
  }
  for (const id of failedIds) ownedIds.delete(id);
  // Carrying `degradations` matters here: this is the branch where
  // EVERY extraction failed, and returning the bare empty result would
  // throw away the only record of why the engine went quiet.
  if (ownedIds.size === 0) return empty(degradations);

  // ── Stage 3: the engine, over the WHOLE window ─────────────────────
  const engineMessages: EngineMessage[] = messages.map((m) => {
    const f = factsById.get(m.waMessageId);
    return {
      id: m.waMessageId,
      body: m.body,
      senderUserId: m.senderUserId,
      senderName: m.senderName ?? m.authorName,
      tagged: m.tagged,
      // A message the engine does not own still carries its real route
      // so the outcome says why nothing happened. `none` is honest for
      // an id the router never mentioned.
      route: m.route ?? "none",
      facts: f?.facts ?? { kind: "none" },
      degraded: f?.degraded ?? null,
    };
  });

  // `decide` asserts its own post-conditions and THROWS on a coverage
  // violation, which is right — a coverage hole is a bug in the engine,
  // not a bad model day. But it must not 500 the analyze request: at
  // this point not one write has happened, so owning nothing costs the
  // batch its replies and costs the squad nothing.
  //
  // It used to say that owning nothing here was "a complete fail-open
  // back to today's behaviour", because the analyzer batch had not been
  // decided yet and would pick the messages up. Since §10 step 8 there
  // is no such batch: this catch drops every attendance message in the
  // window to silence plus the operator note. §11.5 is honest that the
  // engine is a single point of failure; this is what stops it being a
  // single point of OUTAGE, and it no longer pretends to be more than
  // that.
  //
  // DELIBERATELY NO RETRY, unlike the extractor above. `decide()` is
  // pure over `{messages, state, now}` — the same input throws the same
  // way, so a second call buys a second stack trace and nothing else.
  // The retry upstream exists because an overloaded API is transient;
  // a bug in the engine is not.
  let result: EngineResult;
  try {
    result = decide({ messages: engineMessages, state, now });
  } catch (err) {
    console.error(
      "[attendance-engine] the engine threw; NOBODY handles this batch — every attendance " +
        "message in it goes silent and onto the operator note:",
      err,
    );
    return empty();
  }
  for (const d of result.degradations) {
    degradations.push(`${d.stage} ${d.messageId ?? "batch"}: ${d.detail}`);
  }

  // ── Stage 3b: APPLY. Only writes from owned messages. ──────────────
  //
  // The engine cannot produce a write from a message it was not given
  // facts for, so this filter is belt and braces — and belt and braces
  // is the right amount for the one step that can put a player at a
  // pitch with no slot.
  const actorByMessageId = new Map<string, EngineActor>(
    messages.map((m) => [
      m.waMessageId,
      { userId: m.senderUserId, name: m.senderName ?? m.authorName, isAdmin: m.senderIsAdmin },
    ]),
  );
  const applicable = result.writes.filter((w) => ownedIds.has(w.sourceMessageId));
  const foreign = result.writes.length - applicable.length;
  if (foreign > 0) {
    degradations.push(
      `${foreign} write(s) came from a message the engine does not own; refused`,
    );
  }
  const applied = await applyEngineWrites({
    matchId,
    writes: applicable,
    actorByMessageId,
    deps,
  });

  // ── Stage 4: composition ───────────────────────────────────────────
  const composed = compose(result);
  const utteranceByMessageId = new Map<string, string[]>();
  let squadPost: string | null = null;
  for (const u of composed.utterances) {
    if (u.messageId === null) {
      squadPost = u.text;
      continue;
    }
    if (!ownedIds.has(u.messageId)) continue;
    const list = utteranceByMessageId.get(u.messageId) ?? [];
    list.push(u.text);
    utteranceByMessageId.set(u.messageId, list);
  }
  const reactByMessageId = new Map(composed.reacts.map((r) => [r.messageId, r.emoji]));
  for (const n of composed.operatorNotes) degradations.push(n);

  // ── Per-message outcomes ───────────────────────────────────────────
  const appliedByMessage = new Map<string, EngineWriteResult[]>();
  for (const a of applied) {
    const list = appliedByMessage.get(a.write.sourceMessageId) ?? [];
    list.push(a);
    appliedByMessage.set(a.write.sourceMessageId, list);
  }

  const outcomes = new Map<string, EngineMessageOutcome>();
  let lastActed: string | null = null;

  for (const m of owned) {
    // A message whose extraction failed twice is no longer ours.
    //
    // It used to continue "— it is in `batchInputs` and the analyzer
    // will decide it. Producing an outcome for it here would give it two
    // deciders and two replies." Nothing decides it now; it reaches
    // `route.ts:1664` unowned and becomes silence plus a line on the
    // operator note. The `continue` is unchanged and still correct, for
    // a plainer reason: we have no facts for this message, so any
    // outcome built here would be built out of nothing.
    if (!ownedIds.has(m.waMessageId)) continue;
    const engineOutcome = result.outcomes.find((o) => o.messageId === m.waMessageId);
    const writes = appliedByMessage.get(m.waMessageId) ?? [];
    const landed = writes.filter((w) => w.ok).map((w) => w.write);
    const failures = writes
      .filter((w) => !w.ok)
      .map((w) => ({
        action: statusToAction(w.write.status),
        who: w.write.userId === m.senderUserId ? null : w.write.name,
        error: w.error ?? "unknown",
      }));

    const facts = factsById.get(m.waMessageId)?.facts;
    const attendanceFacts: AttendanceFacts | null =
      facts && facts.kind === "attendance" ? facts : null;

    const utterances = utteranceByMessageId.get(m.waMessageId) ?? [];
    // ONE reply per message. Several speech intents for the same
    // message join into one send; they never become two results.
    let reply: string | null = utterances.length > 0 ? utterances.join("\n\n") : null;
    if (landed.length > 0) lastActed = m.waMessageId;

    // An extractor failure must surface to an admin, not vanish. §9
    // keeps the partial-response net and asks for a TYPED error rather
    // than a prefix-matched free-text `reasoning`; this is it.
    //
    // §10 step 8 finished that job elsewhere: the net itself is now
    // `lib/operator-note.ts`, which selects on the typed fact "no owner
    // claimed this id" and never reads prose at all. This branch is
    // reached only for an id we DO still own (a failed one was removed
    // from `ownedIds` above), so the prefix here is the audit trail on
    // the `AnalyzedMessage` row rather than the trigger for anything.
    // Nothing regex-matches it any more, which is the point.
    const degraded = factsById.get(m.waMessageId)?.degraded ?? null;
    const machineReasons = (engineOutcome?.reasons ?? []).join("; ");
    const reasoning = degraded
      ? `${ENGINE_APPLY_DEGRADED_PREFIX} ${degraded}`
      : `attendance-engine (${m.route}): ${machineReasons || "no rule fired"}`;
    if (degraded) reply = null;

    const senderOwnRowMoved = landed.some((w) => w.userId === m.senderUserId);

    outcomes.set(m.waMessageId, {
      waMessageId: m.waMessageId,
      route: m.route as Route,
      reply,
      react: reactByMessageId.get(m.waMessageId) ?? null,
      intent: intentFor(landed, m.senderUserId, attendanceFacts, reply),
      action: analyzedActionFor(landed, m.senderUserId),
      reasoning,
      failures,
      senderOwnRowMoved,
      // PR #33: a recruit ask alongside a drop must do BOTH, and the
      // blast has to run after the drop lands, so the route defers it to
      // the batch-final pass. It used to share that pass with the
      // analyzer's own `recruitRequest`; since §10 step 8 the second
      // reporter is `admin_ops` ("DM the lads from the last 5 games",
      // with a clamped lookback) rather than the analyzer, and the two
      // still share `route.ts`'s one list, one implementation and one
      // dedupe — "only the last one fires" holds across both.
      recruitRequest: !!attendanceFacts?.sideRequests.includes("recruit") && m.senderIsAdmin,
      recordTentativeForUserId: tentativeUserId(attendanceFacts, m.senderUserId, landed),
      resolveTentativeForUserId: senderOwnRowMoved ? m.senderUserId : null,
    });
  }

  return {
    ownedIds,
    outcomes,
    squadPostForMessageId: squadPost ? (lastActed ?? [...ownedIds].at(-1) ?? null) : null,
    matchId,
    degradations,
    cost: { ...cost, ms: Date.now() - t0 },
  };
}

// ── helpers ─────────────────────────────────────────────────────────

function statusToAction(s: EngineAttendanceWrite["status"]): AttendanceWriteFailure["action"] {
  return s === "CONFIRMED" ? "IN" : s === "BENCH" ? "BENCH" : "OUT";
}

/**
 * `AnalyzedMessage.intent`, in the vocabulary the admin log and the
 * `none`-bucket shadow already speak. Derived from the OUTCOME, which
 * is cold-audit 1.3's complaint about the existing column ("records the
 * intent, not the outcome") answered by construction.
 */
export function intentFor(
  landed: EngineAttendanceWrite[],
  senderUserId: string | null,
  facts: AttendanceFacts | null,
  reply: string | null,
): string {
  const own = senderUserId ? landed.find((w) => w.userId === senderUserId) : undefined;
  if (own) return own.status === "DROPPED" ? "out" : "in";
  if (landed.length > 0) return "in";
  if (facts?.claims.some((c) => c.contingent)) return "conditional_in";
  if (facts?.sideRequests.includes("recruit")) return "replacement_request";
  return reply ? "question" : "noise";
}

/**
 * Personal-uncertainty conditionals ("in if my back holds up") write
 * nothing and are chased ~24h before kickoff. The engine declines the
 * write; the follow-up is a real product behaviour that used to live on
 * `executeVerdict`'s `recordTentative`, and step 6 must not lose it.
 * Since §10 step 8 deleted `executeVerdict` there is no other copy: if
 * this function stops returning a user id, the 24h chase simply stops
 * happening for everyone.
 *
 * Read from the FACTS — `contingent` + `conditionOn: "self"` — which is
 * the schema field §9 says `looksLikeConditionalDrop` becomes, not from
 * anybody's prose.
 */
export function tentativeUserId(
  facts: AttendanceFacts | null,
  senderUserId: string | null,
  landed: EngineAttendanceWrite[],
): string | null {
  if (!facts || !senderUserId) return null;
  if (landed.some((w) => w.userId === senderUserId)) return null;
  const self = facts.claims.find(
    (c) =>
      c.subject === "sender" &&
      c.contingent &&
      c.conditionOn === "self" &&
      c.polarity !== "out" &&
      c.tense !== "past" &&
      c.tense !== "hypothetical",
  );
  return self ? senderUserId : null;
}
