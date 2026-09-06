/**
 * THE NEW ANALYZER PIPELINE — shared types.
 *
 * MDs/analyzer-redesign-2026-08-31.md §10 step 2. Four stages:
 *
 *   0. deterministic floor   (regex, §11.1)
 *   1. router                (cheap model, one route per message id, §6.1)
 *   2. extractors            (facts about the TEXT, never decisions, §6.2)
 *   3. decision engine       (pure, deterministic, no I/O, no model, §6.3)
 *   4. composer              (every name and number read from state, §6.4)
 *
 * THE ONE RULE THIS FILE ENFORCES BY SHAPE
 * ----------------------------------------
 * An extractor's output type contains no `intent`, no `registerAttendance`,
 * no `registerFor`, no `react`, no `reply` and no `reasoning`. There is
 * literally no field in which the model can express a decision, and no
 * prose for a regex to parse afterwards. That is what kills 19 of the 54
 * seatbelts (§9): the error class becomes unrepresentable.
 *
 * DRY-RUN. Nothing in this directory writes to the database, sends a
 * WhatsApp message, or queues a notification. The engine returns
 * PROPOSED writes and a PROJECTED next state; the shadow harness
 * persists them for comparison (§10 step 2, "Still zero writes").
 */

// ── Stage 1: routes ────────────────────────────────────────────────────

/**
 * §6.1 lists nine routes and then reports a failure the author could not
 * fix: "move Mustafa to the bench, keep Idris in" routed `team_ops` 3/3,
 * because "bench" reads as team-shaped vocabulary. The doc's own remedy
 * is quoted verbatim: *"probably by renaming `team_ops` → `balancer` and
 * adding `lineup_ops`"*.
 *
 * We take half of that. `team_ops` is renamed `balancer`, which removes
 * the vocabulary collision at its source. We deliberately do NOT add
 * `lineup_ops` as a distinct engine route: roster surgery IS an
 * attendance change about someone else, and a second attendance path
 * would double every capacity and authorisation rule that `other_att`
 * already carries. Instead `lineup_ops` is accepted from the model as an
 * ALIAS and normalised to `other_att` (see `normaliseRoute`), so the
 * router still has a natural landing spot for that vocabulary while the
 * engine only ever sees one attendance route.
 */
export type Route =
  /** banter, jokes, memes, links, emoji, off-topic chat */
  | "none"
  /** the SENDER is joining or leaving THIS match themselves */
  | "self_att"
  /** adds, drops, benches, swaps or replaces SOMEONE ELSE */
  | "other_att"
  /** a contingent or tentative commitment by anyone */
  | "offer"
  /** a question the bot could answer */
  | "question"
  /** generate, show, shuffle or rename the two teams */
  | "balancer"
  /** reports a final result */
  | "score"
  /** payment credit, reminder request, other bot admin instruction */
  | "admin_ops"
  /** attendance-shaped but the router genuinely cannot tell */
  | "unsure";

export const ALL_ROUTES: readonly Route[] = [
  "none",
  "self_att",
  "other_att",
  "offer",
  "question",
  "balancer",
  "score",
  "admin_ops",
  "unsure",
];

/**
 * Where a route came from. `floor` outranks `model` (§11.1).
 *
 * `awaiting` is the same idea as `floor` and inherits its one-directional
 * proof — it can only move a message OUT of `none` — but it is gated on a
 * DATABASE ROW (an open `BenchSlotOffer` / `PendingBenchConfirmation` /
 * `TentativeAvailability`) rather than on the text of the message. See
 * `awaiting-answer.ts` for why the two `👍`s PR #42 found need a fact and
 * not a pattern.
 */
export type RouteSource = "floor" | "awaiting" | "model" | "fallback";

export interface RoutedMessage {
  messageId: string;
  route: Route;
  source: RouteSource;
  /**
   * When `source` is `floor`, the route the MODEL gave that the floor
   * replaced. Absent otherwise.
   *
   * Without this, "how often did the floor rescue a message?" is
   * unanswerable, and the obvious proxy — counting `source === "floor"`
   * — is wrong in a way that flatters the floor: it counts every
   * override, including `other_att → self_att`, which changes nothing
   * about whether the analyzer sees the message. A rescue is
   * specifically `overrodeRoute === "none"`. That mistake was made and
   * caught in the first full recall sweep, where it reported 136
   * rescues against a true count of 0.
   */
  overrodeRoute?: Route;
}

// ── Stage 2: FACTS ─────────────────────────────────────────────────────

export type Polarity = "in" | "out" | "bench";
export type Tense = "present" | "future" | "past" | "hypothetical";
/** What a contingent claim is contingent ON. §3.2 S15: the standing-offer
 *  vs personal-uncertainty split, whose outcomes are opposites. */
export type ConditionOn = "squad" | "self" | "none";

/**
 * Does the message SETTLE this person's attendance, or only report their
 * availability?
 *
 * The schema gap PR #44 left open, found by the §10 step 6 replay sweep:
 *
 *   2026-06-20, Abid Kazmi, ten days before kickoff, squad 0/14 —
 *   "I will be back Tuesday week". The engine registered him CONFIRMED.
 *
 * Three live runs of the shipped extractor on the real message returned
 * `polarity:"in" · contingent:false · conditionOn:"none" · tense:"future"`
 * — which is the SAME shape "I'm in for next Tuesday" returns. `tense`
 * covers WHEN ("future" is right for both) and `contingent` covers
 * WHETHER-IF (neither is conditional). Nothing in the schema covered
 * WHAT THE MESSAGE DOES, so a travel statement and a commitment were
 * literally indistinguishable and the engine had to guess.
 *
 * That is the same class of gap as the one that produced the Omar Yusuf
 * defect — `conditionOn` had no value for "the condition is about a
 * third party's willingness" — and it gets the same treatment: a field,
 * not a paragraph of prose in the prompt telling the model what to do.
 *
 * - `decision`     the message settles it: "I'm in", "count me in",
 *                  "I'm out", "can't make it", "I'll be there".
 * - `availability` the message reports where the person will be or what
 *                  they can do, and leaves the decision unmade: "I'll be
 *                  back Tuesday week", "I land Monday", "I'm away that
 *                  week", "I'm free after the 5th".
 *
 * The engine reads it asymmetrically, on purpose (§13): being ABLE to
 * play is necessary but never sufficient, so an `availability` claim
 * never gives anyone a squad place; being UNABLE to play settles the
 * question by itself, so an `availability` OUT still frees one.
 */
export type ClaimBasis = "decision" | "availability";

/**
 * One attendance claim the TEXT makes. Every field is a property of the
 * message, checkable by re-reading it. None of them is a decision.
 */
export interface Claim {
  /** Who the claim is about. `sender` = the person who typed it. */
  subject: "sender" | "other";
  /** Verbatim, as written. NEVER invented, never expanded to a full name. */
  personRef: string;
  /** Was an actual personal NAME used? "my brother", "2 of my guys",
   *  "someone" → false. This single boolean is what stops a ghost user
   *  called "Amir's brother" being provisioned into a paid squad (§4.1). */
  personNamed: boolean;
  /** in = joining, out = leaving, bench = EXPLICITLY asked for the bench.
   *  The extractor never infers `bench` from squad capacity; capacity is
   *  the engine's job, so every `bench` here is a stated preference. */
  polarity: Polarity;
  contingent: boolean;
  conditionOn: ConditionOn;
  tense: Tense;
  /** Settles it, or merely reports availability. See `ClaimBasis`. */
  basis: ClaimBasis;
  /** Relaying what someone else said ("Najib said he's in"). */
  reported: boolean;
  confidence: number;
}

/** Something the message ALSO asks for, alongside its claims. A message
 *  is allowed to carry several facts and the pipeline must lose none of
 *  them — today's incident was a regex fast path claiming a two-intent
 *  message and throwing half away. */
export type SideRequest =
  /** "anyone able to replace me?", "can someone cover?" — asks the group
   *  (or the bench) for a replacement. */
  | "recruit"
  /** "@all we need more players" — a nudge, NOT the sender leaving. */
  | "chase";

export interface AttendanceFacts {
  kind: "attendance";
  claims: Claim[];
  /** A bare affirmation/refusal answering MatchTime's own last post
   *  ("Confirmed", "yes", "no"). §3.2 S25 — the bot's last post is a
   *  known object, so the engine can resolve what it refers to. */
  affirmation: "yes" | "no" | null;
  sideRequests: SideRequest[];
}

export type QuestionTopic =
  | "squad"
  | "bench"
  | "count"
  | "person_status"
  | "phones"
  | "stats"
  | "options"
  | "other";

export interface QuestionFacts {
  kind: "question";
  topic: QuestionTopic;
  /** Who the question is about, verbatim, when it names anyone. */
  personRef: string | null;
  /** A number the message ASSERTS about the squad ("we're 9/14 right?").
   *  §3.2 S24: the engine compares it to the database. */
  statedCount: number | null;
}

export interface TeamFacts {
  kind: "teams";
  /** show = re-post what exists. generate = run the balancer. §3.2 S19:
   *  "show the teams again" once destroyed an admin's manual swap. */
  action: "show" | "generate" | "rename" | "swap";
  includeRefs: string[];
  teamNames: [string, string] | null;
  swaps: Array<{ personRef: string; team: "RED" | "YELLOW" }>;
}

export interface ScoreFacts {
  kind: "score";
  /** In the order the two teams appear in the match context. */
  first: number;
  second: number;
}

export interface AdminFacts {
  kind: "admin";
  /**
   * `recruit` was added by §10 step 7 part 2, and it is the one admin
   * action the mega-prompt could still do that nothing else could.
   *
   * "@Match Time message all players who played in the last 5 matches
   * and invite them" routes `admin_ops` and used to come back as
   * `other`, i.e. `admin action "other" has no deterministic handler` —
   * so the ONLY thing in the system that recognised a recruit ask on
   * this route was `verdict.recruitRequest` on the 19,850-token prompt
   * (`route.ts:1548` → `inviteRecentPlayers`). A route cannot leave the
   * mega-prompt while one of its real phrasings only works there.
   */
  action: "bulk_payment" | "reminder" | "recruit" | "other";
  /** bulk_payment */
  payerRef?: string;
  count?: number;
  coveredRefs?: string[];
  /** reminder — the PHRASE as written ("on Monday", "tomorrow at 6").
   *  §3.2 S22: calendar arithmetic is `date-fns-tz`'s job, not the
   *  model's. The extractor hands back the words. */
  phrase?: string;
  /** reminder — what the nudge should say, in the sender's own words
   *  ("bring the bibs"). Absent when the message only names a time. */
  note?: string;
  /**
   * recruit — how many recent matches the message asks to draw from
   * ("the last 5 matches"). A FACT ABOUT THE TEXT: absent when the
   * message names no number, and clamped to `[1, RECRUIT_LOOKBACK_MAX]`
   * by the engine before it can reach a mass DM.
   */
  lookbackMatches?: number;
}

export interface NoFacts {
  kind: "none";
}

export type Facts =
  | AttendanceFacts
  | QuestionFacts
  | TeamFacts
  | ScoreFacts
  | AdminFacts
  | NoFacts;

// ── The world the engine decides against ───────────────────────────────

export type AttStatus = "CONFIRMED" | "BENCH" | "DROPPED";

export interface Member {
  userId: string;
  name: string;
  isAdmin: boolean;
  hasPhone: boolean;
}

export interface AttendanceRow {
  userId: string;
  status: AttStatus;
  position: number;
}

export interface BenchOffer {
  id: string;
  /** Whose vacated slot this offer is for. */
  replacingUserId: string | null;
  /** Who the offer was broadcast to (the bench at the time). */
  offeredToUserIds: string[];
}

/**
 * Everything the engine is allowed to know. Loaded once per batch by
 * `load-state.ts` (the only I/O in this directory) and then never
 * re-read: the engine is a pure function of this value.
 */
export interface SquadState {
  /** The ACTIVE registration match, chosen by `selectRegistrationMatch`.
   *  null = no match to register anyone for, or registration is blocked
   *  because a previous match is still in flight. */
  matchId: string | null;
  /** Format TOTAL across both teams (7-a-side → 14). Never per-team. */
  maxPlayers: number;
  /** Pre-formatted for the composer, so it needs no clock and no
   *  timezone library: "Tue 21:30". */
  kickoffLabel: string;
  venue: string;
  rows: AttendanceRow[];
  roster: Member[];
  openOffers: BenchOffer[];
  teams: Array<{ userId: string; team: "RED" | "YELLOW" }>;
  teamLabels: [string, string];
  /**
   * THE LAST MATCH THAT HAS ACTUALLY BEEN PLAYED — the one a score
   * report and a payment credit are about.
   *
   * WIDENED for §10 step 7 part 2, and the name is now slightly wrong on
   * purpose rather than the selection being quietly wrong. Until this
   * change the loaders asked for `status: "COMPLETED"` only, and
   * `answer-batch.ts`'s header records why that blocked the `score`
   * route: the shipped path selects from
   * `TEAMS_PUBLISHED | TEAMS_GENERATED | COMPLETED` (`route.ts:3474-3479`),
   * because a match only becomes `COMPLETED` when somebody records a
   * score. A real Tuesday night therefore sits at `TEAMS_PUBLISHED` for
   * ever if nobody ever reports one, and a `completedMatch` that only
   * held `COMPLETED` rows would refuse the FIRST score of every match —
   * which is every score that matters.
   *
   * The loaders now pick the most recent match whose KICKOFF PLUS
   * DURATION has passed, in any of those three statuses. `status` and
   * `isHistorical` travel with it so the two consumers can narrow it
   * differently, which they do:
   *
   *   • `score` accepts all three statuses. That is the point.
   *   • a payment credit is owned only when `status === "COMPLETED"` and
   *     `!isHistorical`, which is exactly the shipped selector
   *     (`route.ts:3801-3803`). See `admin-ops-engine-batch.ts`.
   *
   * ONE DELIBERATE NARROWING vs the shipped score path: it filters
   * `redScore: null, yellowScore: null` in SQL and then takes the most
   * recent ENDED row, so it walks BACK past a scored match to an older
   * unscored one. This does not: it takes the most recent ended match
   * whatever its score, and `handleScore` refuses to overwrite a result
   * that is already recorded. Owning less on purpose — a score landing
   * on a match two weeks older than the one the group is talking about
   * is a worse outcome than the analyzer keeping the message.
   */
  completedMatch: {
    id: string;
    status: "TEAMS_GENERATED" | "TEAMS_PUBLISHED" | "COMPLETED";
    /** A seeded backfill rather than a match this group played through
     *  MatchTime. Never a payment-credit target. */
    isHistorical: boolean;
    redScore: number | null;
    yellowScore: number | null;
    participantUserIds: string[];
  } | null;
  /** Appearances per user across completed matches, for stats answers
   *  that today cost a whole extra LLM call. */
  appearances: Array<{ userId: string; matches: number }>;
  /** MatchTime's own most recent post in the group, verbatim. A known
   *  object, not a guess: it is how a bare "Confirmed" resolves. */
  lastBotPost: string | null;
  features: {
    attendance: boolean;
    paymentTracking: boolean;
    statsQa: boolean;
    /** The per-org gate `route.ts:3113-3121` maps `reminder_request`
     *  onto. A MoM-and-ratings-only org has it off, and MatchTime must
     *  not queue a reminder DM for one. */
    reminders: boolean;
  };
  /** Smaller formats the org has configured, for the options answer.
   *  Totals across both teams (`playersPerTeam * 2`). */
  smallerFormats: Array<{ sportName: string; totalPlayers: number }>;
  /** Players already asked for a guest's name for this match — the
   *  one-ask-per-player-per-match dedupe key of `guest-name-ask.ts`. */
  guestAskedUserIds: string[];
}

// ── What the engine hands back ─────────────────────────────────────────

export type ProposedWrite =
  | {
      kind: "attendance";
      userId: string;
      name: string;
      status: AttStatus;
      /** True only when a human ASKED for the bench. Drives the PR #27
       *  invariant: a BENCH row means "full" or "asked", never
       *  "a classifier inferred it". */
      explicitBench: boolean;
      /** Straight from the bench into the squad, skipping the 👍 step.
       *  Authorised by `promote-authorization.ts`, never by a model. */
      promote: boolean;
      sourceMessageId: string;
      reason: string;
    }
  | {
      kind: "open_bench_offer";
      replacingUserId: string;
      offeredToUserIds: string[];
      sourceMessageId: string;
      reason: string;
    }
  | {
      kind: "resolve_bench_offer";
      offerId: string;
      claimedByUserId: string;
      sourceMessageId: string;
      reason: string;
    }
  | {
      kind: "score";
      matchId: string;
      red: number;
      yellow: number;
      sourceMessageId: string;
      reason: string;
    }
  | {
      kind: "payment_credit";
      payerUserId: string;
      payerName: string;
      count: number;
      coveredUserIds: string[];
      /**
       * Did the message NAME the people covered, or just give a number?
       *
       * The shipped path branches on exactly this (`route.ts:3841-3886`)
       * and the two branches are different writes: named → stamp
       * `Attendance.paidAt` per row and create NO `PaymentCredit`
       * (double-counting is the failure); a bare count → one
       * `PaymentCredit` row. Inferring it from
       * `coveredUserIds.length > 0` would be wrong in the one case that
       * matters — a message that names two people, neither of whom
       * resolves, would silently become an aggregate credit for a number
       * nobody checked. The engine refuses that case outright, and this
       * flag is what lets the apply layer tell the two apart without
       * re-reading the facts.
       */
      namedCovered: boolean;
      sourceMessageId: string;
      reason: string;
    }
  | {
      kind: "reminder";
      userId: string;
      /** The words as written ("on Monday"), kept for the audit trail.
       *  Nothing downstream parses it — `sendAt` is what is queued. */
      phrase: string;
      /**
       * The resolved instant, in UTC. §3.2 S22 gives the calendar
       * arithmetic to `date-fns-tz` and NOT to the model; `resolveReminderPhrase`
       * is where that happens and it is a pure function of
       * `(phrase, now)`. A phrase it cannot resolve produces no write at
       * all, so this is never a guess.
       */
      sendAt: Date;
      /** "Mon 8 Sep at 18:00" — London, rendered once, by the resolver
       *  that knows whether a time of day was actually stated. */
      whenLabel: string;
      /** What the reminder is ABOUT, for the body of the DM. Falls back
       *  to the message itself when the extractor named nothing, which
       *  is always better than an empty nudge. */
      note: string;
      sourceMessageId: string;
      reason: string;
    }
  | {
      /**
       * A DM blast to players from recent matches. NOT applied beside
       * the other writes, and that is the whole point of modelling it —
       * see `admin-ops-engine-batch.ts`'s `recruitRequest` outcome
       * field. The 2026-09-01 incident was the blast running BEFORE the
       * batch's attendance writes landed, so it counted a squad that the
       * same message was about to change and told the owner it was full.
       * The engine decides WHO may ask; the route decides WHEN it fires,
       * which is after everything else in the batch.
       */
      kind: "recruit_blast";
      /** Already clamped to `[1, RECRUIT_LOOKBACK_MAX]` by the engine.
       *  `null` means "use `LOOKBACK_MATCHES`", the shipped default. */
      lookbackMatches: number | null;
      sourceMessageId: string;
      reason: string;
    };

/**
 * What the bot wants to SAY, as structure. The engine never writes copy;
 * the composer renders these against the projected state, so every name
 * and every number in an outgoing message is read from the world after
 * the writes land rather than authored by anyone (§6.4).
 */
export type SpeechIntent =
  /** The one authoritative squad post for the batch (§3.2 S36). */
  | { kind: "squad_status"; messageId: string | null }
  | { kind: "guest_name_ask"; messageId: string; askerName: string | null; body: string }
  | { kind: "answer_bench"; messageId: string }
  | { kind: "answer_count"; messageId: string; statedCount: number | null }
  | { kind: "answer_person_status"; messageId: string; personRef: string; userId: string | null }
  | { kind: "answer_phones"; messageId: string }
  | { kind: "answer_stats"; messageId: string }
  | { kind: "answer_options"; messageId: string }
  | { kind: "teams_post"; messageId: string }
  | { kind: "score_ack"; messageId: string; red: number; yellow: number }
  | { kind: "payment_ack"; messageId: string; payerName: string; count: number }
  /** `whenLabel` is the RESOLVED time ("Mon 8 Sep at 18:00"). The
   *  composer must never echo the raw phrase back at a player as if it
   *  were a confirmation — "I'll nudge you on Monday" is not a promise
   *  anybody can check, and `route.ts:3986-3992` already says the
   *  resolved label out loud for exactly that reason. */
  | { kind: "reminder_ack"; messageId: string; phrase: string; whenLabel: string | null }
  | { kind: "bench_offer_open"; messageId: string; replacingName: string }
  /** A resolved "Confirmed" whose writes were all idempotent. Saying
   *  nothing there is the silent-no-op failure in miniature. */
  | { kind: "pending_confirmed_ack"; messageId: string; userIds: string[] }
  /** A bench player answered an open offer and the slot had already
   *  gone. Silence there is the 2026-05-19 Karahan shape. */
  | { kind: "bench_claim_too_late"; messageId: string; userId: string }
  /** Something failed and the bot says so rather than going quiet. */
  | { kind: "degraded"; messageId: string; reason: string };

export type Disposition = "acted" | "noop" | "degraded";

/**
 * EXACTLY ONE per input message id, always. §3.2 S1's incident (Ibrahim
 * and Baki, 2026-05-25) was two clear drops silently omitted from the
 * verdict array; the prompt grew a 272-token VERDICT COVERAGE banner to
 * ask the model not to do it again. Here it is a post-condition asserted
 * in code, and `assertCoverage` throws if it is ever violated.
 */
export interface MessageOutcome {
  messageId: string;
  route: Route;
  disposition: Disposition;
  /** Machine-readable, one per rule that fired. Never prose for a regex
   *  to parse later — these are for humans and for triage queries. */
  reasons: string[];
  writes: ProposedWrite[];
  react: string | null;
}

export interface Degradation {
  stage: "router" | "extractor" | "engine" | "composer" | "state";
  messageId: string | null;
  /** Loud on purpose. Four seatbelts were found dead on 2026-08-31, all
   *  silent, all with comments claiming they worked. */
  detail: string;
}

export interface EngineResult {
  outcomes: MessageOutcome[];
  writes: ProposedWrite[];
  /** The world as it WOULD be after the writes. The composer reads this,
   *  never the model's memory. In dry-run it is the only "database". */
  nextState: SquadState;
  speech: SpeechIntent[];
  degradations: Degradation[];
}

// ── Stage 3 input ──────────────────────────────────────────────────────

export interface EngineMessage {
  id: string;
  body: string;
  /** Resolved sender, or null for an unknown pushname / opaque @lid. */
  senderUserId: string | null;
  senderName: string | null;
  /** Did this message @-mention the bot? The interaction-contract signal. */
  tagged: boolean;
  route: Route;
  facts: Facts;
  /** Set when a stage above failed for this message. The engine must
   *  surface it, never swallow it. */
  degraded?: string | null;
}

export interface EngineInput {
  messages: EngineMessage[];
  state: SquadState;
  /** Injected so the engine stays pure (no clock). */
  now: Date;
}

// ── The shadow payload ─────────────────────────────────────────────────

/**
 * What the dry run persists to `WindowVerdict.verdictJson`.
 *
 * The first four fields are EXACTLY the 2026-05-29 `WindowVerdict`
 * shape, so `/admin/shadow` renders a v2 row with no change at all. The
 * last two are the detail that shape cannot hold, and are what §10 step
 * 3's go/no-go is actually read from.
 */
export interface WindowShapedVerdict {
  windowSummary: string;
  stateChanges: Array<{
    action: "drop" | "add" | "bench";
    targetName: string;
    targetUserId: string;
    reason: string;
  }>;
  reactions: Array<{ waMessageId: string; emoji: string; kind: string }>;
  groupReply: string | null;
  pipeline: "dryrun-v2";
  proposal: Record<string, unknown>;
}
