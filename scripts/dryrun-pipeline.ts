/**
 * ═══════════════════════════════════════════════════════════════════════
 * DRY RUN — the whole pipeline against LIVE production state.
 *
 *   router → extractors → engine → composer, over the real Sutton FC
 *   squad, with the real model. It decides, projects and composes; it
 *   writes NOTHING.
 *
 * ── ZERO WRITES, structurally ────────────────────────────────────────
 * Not a promise, a property. The only database call in this file is
 * `loadSquadState`, whose module header says it is "THE ONLY I/O IN THIS
 * DIRECTORY … READ-ONLY BY CONSTRUCTION: every statement here is a
 * `findMany` / `findFirst` / `count`". `runPipeline` is dry-run by
 * design — "nothing in this module writes to the database, sends a
 * message, queues a notification or touches the live analyze route. It
 * returns a PROPOSAL and a PROJECTION". Everything printed under
 * `writes :` below is what the engine WOULD do, on a projected state
 * that lives in memory and is thrown away when the process exits.
 *
 * There is no Prisma client in this file other than the one
 * `loadSquadState` uses, and no code path here calls `create`, `update`,
 * `upsert` or `delete`. Keep it that way: this script is pointed at a
 * customer's live squad eight days before a real match.
 *
 * ── IT COSTS REAL MONEY ──────────────────────────────────────────────
 * Every run is real router + extractor calls billed to the live
 * ANTHROPIC_API_KEY. One case is roughly $0.003–$0.01. `REPEAT=15` over
 * the whole table is a few dollars. The per-run cost is printed, and so
 * is the total.
 *
 * ── HOW TO RUN ───────────────────────────────────────────────────────
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/dryrun-pipeline.ts
 *
 *   # or, if your shell exports the env for you:
 *   set -a; source .env; set +a
 *   npx tsx scripts/dryrun-pipeline.ts
 *
 * Needs DATABASE_URL and ANTHROPIC_API_KEY.
 *
 *   ONLY=C1,K1     run only these case ids (comma-separated)
 *   REPEAT=15      run each case N times and report STABLE / UNSTABLE
 *   FACTS=1        print basis / contingent / conditionOn on every run,
 *                  not just when REPEAT=1
 *   CHASES=1       compose all five scheduled-chase kinds instead of
 *                  running the case table (also read-only)
 *   QUESTIONS=1    run the TAGGED-QUESTION table (Q*) through §10 step
 *                  7's owner instead, and score every phrasing as
 *                  ANSWERED / HANDED BACK / SILENT. See `runQuestions`.
 *   ORG_GROUP=…    a different WhatsApp group id (defaults to Sutton FC)
 *
 * Examples:
 *   ONLY=P1 REPEAT=15 FACTS=1 …   settle one ambiguous phrasing
 *   ONLY=K1,K2,K3 …               replay the 1 Sept incident three ways
 *   CHASES=1 …                    read the five scheduled posts
 *
 * ── WHAT THE CASES ARE ───────────────────────────────────────────────
 * They are not synthetic. C1–C15 / D1–D3 / K1–K3 are real messages from
 * the group or real incidents; P1–P4 are the four probes that settle the
 * availability / standing-offer boundary. S1–S3 / A1–A5 / R1–R5 are §10
 * step 7 part 2's two writing routes — the score report, the payment
 * credit, the reminder and the recruit blast Kemal asked about on
 * 2026-09-06. Each carries an `expect`
 * string: what a human decided the right answer is. The harness does NOT
 * grade against it — it prints it next to what happened so you can. (The
 * graded, CI-runnable version of this idea is `e2e/corpus/`.)
 * ═══════════════════════════════════════════════════════════════════════
 */
import { loadSquadState } from "../src/lib/pipeline/load-state.ts";
import { runPipeline } from "../src/lib/pipeline/run.ts";
import { runAnswerBatch } from "../src/lib/pipeline/answer-batch.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { anthropicModel } from "../src/lib/pipeline/llm.ts";
import { getOrgFeatures } from "../src/lib/org-features.ts";
import { composeChaseText, type ChaseKind } from "../src/lib/message-analyzer.ts";
import { db } from "../src/lib/db.ts";
import type { AttendanceRow, Member, Route, SquadState } from "../src/lib/pipeline/types.ts";

/** Sutton FC. Overridable so the harness is not welded to one customer. */
const DEFAULT_GROUP = "447525334985-1607872139@g.us";

type Case = {
  id: string;
  /** Sender, BY NAME. Resolved against the live roster at startup — no
   *  user id is hardcoded, so a roster change fails loudly here instead
   *  of silently attributing a message to the wrong person. */
  who: string;
  /** Display name on the message. Defaults to `who`. */
  as?: string;
  body: string;
  tagged?: boolean;
  /** Fill the squad from the roster before running — for replaying an
   *  incident that only happens at 14/14. See `FULL_SQUAD_INCLUDES` /
   *  `FULL_SQUAD_BENCH` for who ends up where, and override per case. */
  fullSquad?: boolean;
  /** Who the fill must put IN the squad. Defaults to `FULL_SQUAD_INCLUDES`. */
  squadIncludes?: string[];
  /** Who the fill parks on the bench. Defaults to `FULL_SQUAD_BENCH`. */
  benched?: string;
  expect: string;
};

/** Najib is the player every `fullSquad` incident replay is ABOUT — the
 *  1 Sept "Najib is out" that MatchTime answered with "the squad is
 *  already full". If he is not in the squad, the replay tests nothing. */
const FULL_SQUAD_INCLUDES = ["Najib"];
/** Amir is the player C15b's grievance is about ("Matchtime put my name
 *  down as reserve without my confirm"), so the fill benches him. */
const FULL_SQUAD_BENCH = "Amir";

const CASES: Case[] = [
  // ── C: everyday traffic ───────────────────────────────────────────
  { id: "C1", who: "Ali", body: "In", expect: "WRITE Ali CONFIRMED" },
  { id: "C2", who: "Wasim", body: "Sorry lads can't make it Tuesday", expect: "DROP Wasim (he is in the squad)" },
  { id: "C3", who: "Mojib", body: "I'm out", expect: "NO write (not registered), stay silent" },
  { id: "C4", who: "Ilkay", body: "I'm around on Tuesday", expect: "NO write — availability is not a commitment (PR #46)" },
  { id: "C5", who: "Ilkay", body: "I'm free Tuesday if you need me", expect: "NO write — availability, not commitment" },
  { id: "C6", who: "Abid Kazmi", body: "maybe, 50/50 at the moment", expect: "NO confirmed write — tentative" },
  { id: "C7", who: "Amir", body: "@Kemal Ediz my brother can play if needed", expect: "NO attendance write for an unnamed guest; may ask for the name" },
  { id: "C8", who: "Elvin", body: "Shahrokh is IN", expect: "third-party guest registration — a write for Shahrokh is acceptable, must not touch Elvin" },
  { id: "C9", who: "Zair", body: "https://www.instagram.com/reel/DcqjVdJp6Iq/", expect: "SILENT noise" },
  { id: "C10", who: "Ali", body: "how many do we need?", expect: "SILENT — untagged non-attendance question (interaction contract)" },
  { id: "C11", who: "Ali", body: "@Match Time how many do we need?", tagged: true, expect: "ANSWER with the number still needed" },
  { id: "C12", who: "Enayem Rashid", body: "1. Kemal\n2. Mustafa\n3. Wasim\n4. Idris\n5. Burak\n6. David\n7. Ali\n8. Mojib", expect: "CLAMPED — must not rewrite the squad wholesale (PR #39)" },
  { id: "C13", who: "Zair", body: "Najib is out. We need one more player. Can someone pls come forward", expect: "recruit + third-party OUT. Najib is NOT in the squad, so no drop. Must NOT claim the squad is full" },
  { id: "C14", who: "Zair", body: "Najib is out. We need one more player. Can someone pls come forward", fullSquad: true, expect: "the 1 Sept incident replayed at a FULL squad. Must not reply 'squad is already full' and ignore the OUT" },
  { id: "C15", who: "Amir", body: "I can't come. Matchtime put my name down as reserve without my confirm", expect: "treat as OUT/grievance; must not silently confirm him" },
  { id: "C15b", who: "Amir", body: "I can't come. Matchtime put my name down as reserve without my confirm", fullSquad: true, expect: "Amir IS on the bench here. Expect he is taken OFF, not left on it" },

  // ── D: the same third-party OUT, phrased three ways ───────────────
  { id: "D1", who: "Zair", body: "Najib is out", fullSquad: true, expect: "bare third-party OUT, Najib in squad -> DROP Najib" },
  { id: "D2", who: "Zair", body: "Najib is out. We need one more player.", fullSquad: true, expect: "OUT + recruit -> DROP Najib" },
  { id: "D3", who: "Zair", body: "Najib can't make it tonight", fullSquad: true, expect: "third-party OUT phrased differently -> DROP Najib" },

  // ── K: the 1 Sept incident, as it actually happened ───────────────
  { id: "K1", who: "Kemal", body: "Najib is out. We need one more player. Can someone pls come forward", fullSquad: true, expect: "THE ACTUAL 1 SEPT INCIDENT. Admin + recruit => addressedByRecruit. Expect DROP Najib, NEVER 'squad is already full'" },
  { id: "K2", who: "Kemal", body: "Najib is out", fullSquad: true, expect: "admin, NO recruit clause => still untagged third-party OUT. Documented behaviour is silence" },
  { id: "K3", who: "Kemal", body: "@Match Time Najib is out", tagged: true, fullSquad: true, expect: "tagged third-party OUT => DROP Najib" },

  // ── P: the availability / standing-offer boundary ─────────────────
  //
  // The four probes that settle it. The two ends were always stable;
  // P1 was a coin flip until the `basis` rule was rewritten around the
  // VERB (PR #48). Kemal's decision, 2026-09-05: P1 must NOT register
  // the sender — a real player complained on 1 Sept, "I can't come.
  // Matchtime put my name down as reserve without my confirm".
  { id: "P1", who: "Ilkay", body: "I'm free Tuesday if you need me", expect: "NO write — a state verb plus a courtesy is availability, never an ask" },
  { id: "P2", who: "Ilkay", body: "I'm around if you're short", expect: "NO write — availability + politeness" },
  { id: "P3", who: "Ilkay", body: "put me down if you're short", expect: "WRITE — 'put me down' asks for the place (standing offer, S15a)" },
  { id: "P4", who: "Ilkay", body: "count me as the 14th if you need one", expect: "WRITE — claims the place (standing offer, S15a)" },

  // ── S: the score route (§10 step 7 part 2) ────────────────────────
  //
  // Untagged on purpose: `score` is deliberately EXCLUDED from
  // `ACTIONY_INTENTS` (interaction-contract.ts:125-129), so every real
  // "we won 5-3" in a group is untagged and a tag gate here would refuse
  // all of them.
  { id: "S1", who: "Kemal", body: "Red won 5-3 last night", expect: "route=score, WRITE score 5-3 against the last match PLAYED (any of TEAMS_PUBLISHED | TEAMS_GENERATED | COMPLETED)" },
  { id: "S2", who: "Zair", body: "we lost 2-6 lads, shocking", expect: "route=score. Zair must be a participant or an admin, or NO write — the §9 authorisation seatbelt" },
  { id: "S3", who: "Kemal", body: "good game that", expect: "NOT a score. Must produce no score write" },

  // ── A: the admin_ops route (§10 step 7 part 2) ────────────────────
  //
  // Payment and reminder both require the tag; the recruit blast does
  // not, because PR #33's RECRUIT_COMMAND_IMPLIES_ADDRESSED makes an
  // admin's recruit command a direct instruction to MatchTime.
  { id: "A1", who: "Kemal", body: "@Match Time Amir paid for 4 players", tagged: true, expect: "route=admin_ops, action=bulk_payment, WRITE payment_credit (aggregate, namedCovered false)" },
  { id: "A2", who: "Kemal", body: "@Match Time Amir paid for Faris and Adam", tagged: true, expect: "route=admin_ops, action=bulk_payment, namedCovered TRUE — a different write from A1" },
  { id: "A3", who: "Zair", body: "@Match Time Amir paid for 4 players", tagged: true, expect: "NO write — only an admin may credit a payment (real money, live club)" },
  { id: "A4", who: "Kemal", body: "@Match Time remind me tomorrow at 6 to bring the bibs", tagged: true, expect: "route=admin_ops, action=reminder, WRITE reminder with a RESOLVED sendAt — not the words" },
  { id: "A5", who: "Kemal", body: "@Match Time remind me before the match", tagged: true, expect: "NO write — the resolver refuses a phrase it cannot read rather than guessing a day" },

  // ── R: the recruit blast, the phrasing Kemal asked about ──────────
  //
  // Before this change every one of these routed `admin_ops` and came
  // back as `admin action \"other\" has no deterministic handler`, so the
  // ONLY thing that recognised them was the mega-prompt's
  // `verdict.recruitRequest`.
  { id: "R1", who: "Kemal", body: "@Match Time message all players who played in the last 5 matches to DM and invite them", tagged: true, expect: "route=admin_ops, action=recruit, lookbackMatches 5, WRITE recruit_blast. NO DM is sent from here — the route fires it after the batch" },
  // MEASURED 2026-09-06: the model reads "the last few games" as 3, not
  // as "unstated". That is a reading of the text and it is inside the
  // clamp, so it is safe either way — but the expectation says what
  // actually happens rather than what would have been tidier.
  { id: "R2", who: "Kemal", body: "@Match Time can you DM the lads from the last few games and ask them to play", tagged: true, expect: "same. 'the last few' comes back as a small number (measured: 3), which the clamp accepts; an unstated lookback would be null -> the default of 5" },
  // MEASURED 2026-09-06: the ROUTER needs the "invite them" half to call
  // this `admin_ops`; "message everyone from the last 50 games" alone
  // routes `question` 5/5. Phrased the way a real admin would, so the
  // clamp is exercised on a live route rather than only in a unit test.
  { id: "R3", who: "Kemal", body: "@Match Time DM everyone who played in the last 50 games and invite them", tagged: true, expect: "50 must be CLAMPED to 12 — a mass DM is how the WhatsApp account gets banned" },
  // MEASURED 2026-09-06: untagged, the ROUTER calls this `question`, not
  // `admin_ops`, so PR #33's tag-free path is not reached and the
  // interaction contract refuses it. Recorded rather than asserted: it
  // is a router property, not this step's, and the tagged R3 is what
  // exercises the clamp.
  { id: "R3b", who: "Kemal", body: "message everyone from the last 50 games", tagged: false, expect: "measured: routes `question`, so the contract's tag gate refuses it. The admin recruit path is reached only when the router says admin_ops" },
  { id: "R4", who: "Zair", body: "@Match Time message all players who played in the last 5 matches and invite them", tagged: true, expect: "NO recruit_blast — only an admin may send one" },
  { id: "R5", who: "Kemal", body: "@Match Time who played in the last 5 matches?", tagged: true, expect: "NOT recruit — asking to LIST the recent players is not asking to message them" },
];

/**
 * ── THE TAGGED-QUESTION TABLE (`QUESTIONS=1`) ─────────────────────────
 *
 * Twenty-four phrasings a Sunday-league group actually sends, all
 * @-tagged (step 7 requires a tag unconditionally, so an untagged
 * question is out of scope by construction and is covered by the
 * interaction-contract tests instead).
 *
 * They are run through `runAnswerBatch` — the thing PRODUCTION would run
 * with the flags on — and not through `runPipeline`. That distinction is
 * the whole reason this block exists. `runPipeline` has no ownership
 * layer and no analyzer behind it, so a message step 7 deliberately
 * declines shows up there as "(silent)" and looks identical to a defect.
 * The 2026-09-06 measurement that started this change read seven
 * silences off `runPipeline` for exactly that reason; four were a real
 * defect (topic `fixture` did not exist) and three were the carve-outs
 * working. Here they are scored apart:
 *
 *   ANSWERED     step 7 owns it and composed a reply
 *   HANDED BACK  step 7 declined it AND SAID WHY — in production the
 *                mega-prompt then answers it, so this is not a silence
 *   SILENT       neither. This column must read 0. Anything in it is
 *                §9's signature failure: "message understood, action
 *                silently not taken".
 *
 * `expect` is what a human decided the right column is. The harness
 * prints both and marks a mismatch; it does not fail the process, for
 * the same reason the C/D/K/P table does not.
 */
type QuestionCase = {
  id: string;
  who: string;
  body: string;
  expect: "ANSWERED" | "HANDED BACK";
  /** What the answer has to contain to be right, when it is answered. */
  wants?: RegExp;
  why: string;
};

const QUESTION_CASES: QuestionCase[] = [
  // ── The twelve from the 2026-09-06 sweep, verbatim ────────────────
  { id: "Q1", who: "Ali", body: "@Match Time how many do we need?", expect: "ANSWERED", wants: /\d+\/\d+/, why: "count" },
  { id: "Q2", who: "Ali", body: "@Match Time who's in?", expect: "ANSWERED", wants: /Playing:/, why: "roster, not a count" },
  { id: "Q3", who: "Ali", body: "@Match Time whats the score situation", expect: "ANSWERED", wants: /\d+\/\d+/, why: "count — 'score' here means the tally, not a result" },
  { id: "Q4", who: "Ali", body: "@Match Time are we playing tuesday?", expect: "ANSWERED", wants: /\d{1,2}:\d{2}/, why: "fixture" },
  { id: "Q5", who: "Ali", body: "@Match Time how many spots left", expect: "ANSWERED", wants: /\d+\/\d+/, why: "count" },
  { id: "Q6", who: "Ali", body: "@Match Time list the players", expect: "ANSWERED", wants: /Playing:/, why: "roster" },
  { id: "Q7", who: "Ali", body: "@Match Time what time is kickoff", expect: "ANSWERED", wants: /\d{1,2}:\d{2}/, why: "fixture" },
  { id: "Q8", who: "Ali", body: "@Match Time where are we playing", expect: "ANSWERED", wants: /at \S/, why: "fixture — the venue" },
  { id: "Q9", who: "Ali", body: "@Match Time do we have enough?", expect: "ANSWERED", wants: /\d+\/\d+/, why: "count" },
  { id: "Q10", who: "Ali", body: "@Match Time show me the squad", expect: "ANSWERED", wants: /Playing:/, why: "roster — NOT the team line-ups" },
  { id: "Q11", who: "Ali", body: "@Match Time is the game still on", expect: "ANSWERED", wants: /\d{1,2}:\d{2}/, why: "fixture" },
  { id: "Q12", who: "Ali", body: "@Match Time who hasn't paid", expect: "HANDED BACK", why: "no payment data in SquadState; the analyzer keeps money questions" },

  // ── More of the same shapes, phrased as the group phrases them ────
  { id: "Q13", who: "Zair", body: "@Match Time whos playing tonight", expect: "ANSWERED", wants: /Playing:/, why: "roster" },
  { id: "Q14", who: "Zair", body: "@Match Time how many are we", expect: "ANSWERED", wants: /\d+\/\d+/, why: "count" },
  { id: "Q15", who: "Zair", body: "@Match Time we're 9/14 right?", expect: "ANSWERED", wants: /\d+\/\d+/, why: "count with a stated number — S24 fact-check" },
  { id: "Q16", who: "Zair", body: "@Match Time who's on the bench?", expect: "ANSWERED", why: "bench" },
  { id: "Q17", who: "Zair", body: "@Match Time same place as usual?", expect: "ANSWERED", wants: /at \S/, why: "fixture — the venue" },
  { id: "Q18", who: "Zair", body: "@Match Time what time we kicking off", expect: "ANSWERED", wants: /\d{1,2}:\d{2}/, why: "fixture" },
  { id: "Q19", who: "Amir", body: "@Match Time is Zair in?", expect: "ANSWERED", wants: /Zair/, why: "person_status, resolvable" },
  { id: "Q20", who: "Amir", body: "@Match Time is my mate down for tuesday", expect: "HANDED BACK", why: "person_status that cannot resolve to one member" },
  { id: "Q21", who: "Amir", body: "@Match Time anyone in the squad without a number?", expect: "ANSWERED", why: "phones" },
  { id: "Q22", who: "Amir", body: "@Match Time who's been most consistent this season?", expect: "HANDED BACK", why: "stats — the composed leaderboard trips displaysSquadState (2026-05-14)" },
  { id: "Q23", who: "Amir", body: "@Match Time we're short, what are our options?", expect: "HANDED BACK", why: "options — the lead carries a count and would be replaced by the roster" },
  { id: "Q24", who: "Elvin", body: "@Match Time show me the teams", expect: "ANSWERED", why: "balancer/show — a real post if teams exist, the shipped 'no teams generated yet' if not" },
];

/** The two lines above every case, so the model sees a group mid-chase. */
const HISTORY = [
  { author: "MatchTime", body: "🗓 Squad update\n\nWe're short for Tuesday 7-a-side — need more bodies." },
  { author: "Kemal Ediz", body: "come on lads, need a few more for Tuesday" },
];

// ── Roster lookup, by name ────────────────────────────────────────────

/**
 * Find a member by display name. Exact match first, then a unique
 * case-insensitive prefix — "Ali" and "Abid Kazmi" are how the group
 * writes them, and neither is a user id.
 *
 * Fails LOUDLY and by name. Hardcoded cuids in the scratch version of
 * this script would have silently attributed a message to whoever
 * inherited the id after a merge; a missing name must stop the run.
 */
function memberByName(roster: Member[], name: string): Member {
  const exact = roster.filter((m) => m.name === name);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new Error(
      `roster has ${exact.length} members called "${name}" — disambiguate the case table`,
    );
  }
  const lower = name.toLowerCase();
  const prefix = roster.filter((m) => m.name.toLowerCase().startsWith(lower));
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1) {
    throw new Error(
      `"${name}" is ambiguous in the roster — matches ${prefix
        .map((m) => `"${m.name}"`)
        .join(", ")}. Use the full name in the case table.`,
    );
  }
  throw new Error(
    `no roster member matches "${name}". The roster has ${roster.length} members: ` +
      roster
        .map((m) => m.name)
        .sort()
        .join(", "),
  );
}

/**
 * Fill the squad to `maxPlayers`, then park one player on the bench. For
 * replaying an incident that only reproduces at 14/14.
 *
 * `include` goes in FIRST and is the load-bearing part: every incident
 * replay in this table is about one named player being dropped, and he
 * has to be in the squad the fill produces or the case silently tests
 * nothing. The rest is topped up in roster order.
 *
 * Purely in-memory — `state` is structuredCloned and never persisted.
 */
function fillSquad(state: SquadState, include: string[], benchName: string): SquadState {
  const s = structuredClone(state);
  const taken = new Set(s.rows.map((r) => r.userId));
  const bench = memberByName(s.roster, benchName);
  const seed = include.map((n) => memberByName(s.roster, n));

  for (const m of [...seed, ...s.roster]) {
    if (s.rows.length >= s.maxPlayers) break;
    if (taken.has(m.userId) || m.userId === bench.userId) continue;
    taken.add(m.userId);
    s.rows.push({ userId: m.userId, status: "CONFIRMED", position: s.rows.length + 1 });
  }
  if (s.rows.length < s.maxPlayers) {
    throw new Error(
      `fullSquad needs ${s.maxPlayers} players but the roster only has ${s.roster.length}`,
    );
  }
  for (const m of seed) {
    if (!taken.has(m.userId)) {
      throw new Error(
        `fullSquad could not fit "${m.name}" into ${s.maxPlayers} slots — ` +
          `the squad already had ${state.rows.length} rows, so the replay would test nothing`,
      );
    }
  }
  if (!taken.has(bench.userId)) {
    s.rows.push({ userId: bench.userId, status: "BENCH", position: s.rows.length + 1 });
  }
  return s;
}

// ── Reporting ─────────────────────────────────────────────────────────

const nameOf = (state: SquadState, userId: string): string =>
  state.roster.find((m) => m.userId === userId)?.name ?? userId;

function describeSquad(state: SquadState): string {
  const confirmed = state.rows.filter((r: AttendanceRow) => r.status === "CONFIRMED");
  const bench = state.rows.filter((r: AttendanceRow) => r.status === "BENCH");
  return (
    `${confirmed.length}/${state.maxPlayers} confirmed` +
    (bench.length ? `, ${bench.length} on the bench` : "") +
    `\n  squad: ${confirmed.map((r) => nameOf(state, r.userId)).join(", ") || "(empty)"}` +
    (bench.length ? `\n  bench: ${bench.map((r) => nameOf(state, r.userId)).join(", ")}` : "")
  );
}

/** Kinds whose whole purpose is the countdown — they MUST name the
 *  kickoff time. PR #47 pins the same three in the prompt. */
const KICKOFF_TIME_REQUIRED: ChaseKind[] = [
  "chase-pre-kickoff",
  "pre-kickoff-full",
  "pre-kickoff-short",
];

/**
 * Compose all five scheduled chases and check the copy reads as English.
 *
 * The checks are the shapes the 2026-09-05 dry run actually produced:
 * "for on Tue 8 Sept 21:30's 7-a-side" (a preposition doubled by
 * `enforceProximity`) and "on Tue 8 Sept 21:30 at 21:30" (the kickoff
 * time printed twice, because the "day label" carried it). Plus the
 * regression direction: three kinds must still state the kickoff time.
 *
 * Read-only. `composeChaseText` reads the match and returns text; the
 * scheduler and WhatsApp are not involved.
 */
async function runChases(groupId: string): Promise<void> {
  const KINDS: ChaseKind[] = [
    "daily-in-list",
    "match-day-morning",
    "chase-pre-kickoff",
    "pre-kickoff-full",
    "pre-kickoff-short",
  ];
  /** A preposition immediately followed by another one. */
  const DOUBLED_PREPOSITION = /\b(?:for|at|on|by|from|until|before|after)\s+on\s/i;
  let failures = 0;

  for (const kind of KINDS) {
    const text = await composeChaseText({ groupId, kind });
    console.log(`══════════════════ ${kind} ══════════════════\n${text ?? "(null — fell back to static text)"}\n`);
    if (!text) {
      console.log("  ⚠️  null — the scheduler would post the STATIC fallback\n");
      failures++;
      continue;
    }
    const problems: string[] = [];
    const doubled = text.match(DOUBLED_PREPOSITION);
    if (doubled) problems.push(`doubled preposition: ${JSON.stringify(doubled[0].trim())}`);
    // Only the LEAD is checked for a repeated time — the roster block
    // below it never contains one.
    const lead = text.split(/\n\s*\*?Playing/)[0];
    for (const [time, hits] of Object.entries(
      [...lead.matchAll(/\b\d{1,2}:\d{2}\b/g)].reduce<Record<string, number>>(
        (acc, m) => ({ ...acc, [m[0]]: (acc[m[0]] ?? 0) + 1 }),
        {},
      ),
    )) {
      if (hits > 1) problems.push(`"${time}" appears ${hits}× in the lead`);
    }
    if (KICKOFF_TIME_REQUIRED.includes(kind) && !/\b\d{1,2}:\d{2}\b/.test(lead)) {
      problems.push("no kickoff time, and this kind requires one");
    }
    if (problems.length) {
      failures++;
      console.log(`  ❌ ${problems.join(" | ")}\n`);
    } else {
      console.log("  ✅ reads as English, kickoff time as expected\n");
    }
  }
  console.log(
    failures === 0
      ? "All five chase kinds pass. Writes performed: 0."
      : `⚠️  ${failures} of ${KINDS.length} chase kinds have a problem. Writes performed: 0.`,
  );
}

/**
 * Run the tagged-question table through §10 step 7's owner.
 *
 * READ-ONLY, twice over: `runAnswerBatch` proposes no writes at all
 * (`__tests__/zero-writes.test.ts` scans its whole directory on every
 * build, and the function refuses the batch if the engine ever hands it
 * one), and the state it decides against is injected here from a single
 * `loadSquadState` read that is then handed to every case unchanged.
 *
 * The router runs per case rather than once over all of them, because a
 * real WhatsApp window carries one or two messages and a batch of
 * twenty-four questions is a context the router will never see in
 * production. It costs one extra call per case and buys a number that
 * means something.
 */
async function runQuestions(orgId: string, state: SquadState, now: Date): Promise<void> {
  const repeat = Math.max(1, Number(process.env.REPEAT ?? 1));
  const only = process.env.ONLY?.split(",").map((s) => s.trim());
  const selected = QUESTION_CASES.filter((c) => !only || only.includes(c.id));
  if (only) {
    const unknown = only.filter((id) => !QUESTION_CASES.some((c) => c.id === id));
    if (unknown.length) throw new Error(`ONLY names no such question case: ${unknown.join(", ")}`);
  }
  const features = await getOrgFeatures(orgId);
  const model = anthropicModel();
  const senders = new Map(selected.map((c) => [c.id, memberByName(state.roster, c.who)]));

  let answered = 0;
  let handedBack = 0;
  let silent = 0;
  let wrongAnswer = 0;
  let mismatched = 0;
  let runs = 0;
  let totalUsd = 0;

  for (const c of selected) {
    const sender = senders.get(c.id)!;
    console.log(`\n${"─".repeat(72)}\n${c.id}  ${sender.name} [@tagged]: ${JSON.stringify(c.body)}\n  expect : ${c.expect} (${c.why})`);

    for (let n = 0; n < repeat; n++) {
      const id = `${c.id}-${n}`;
      const routed = await routeBatch(model, [{ id, authorName: sender.name, body: c.body }]);
      const route: Route = routed.routes[0]?.route ?? "unsure";
      totalUsd += routed.usage?.costUsd ?? 0;

      const res = await runAnswerBatch({
        orgId,
        now,
        messages: [
          {
            waMessageId: id,
            body: c.body,
            authorName: sender.name,
            senderUserId: sender.userId,
            senderName: sender.name,
            tagged: true,
            route,
            gated: false,
          },
        ],
        history: HISTORY,
        expectedMatchId: state.matchId,
        enabled: new Set<Route>(["question", "balancer"]),
        // Injected so the whole sweep decides against ONE state read.
        deps: { model, loadState: async () => state, loadFeatures: async () => features },
      });
      totalUsd += res.cost.usd;
      runs++;

      const outcome = res.outcomes.get(id);
      const reply = outcome?.reply ?? null;
      // The three columns. A message the ROUTER sent somewhere step 7
      // does not own is a hand-back too — the analyzer decides it — and
      // saying so is why the route is printed beside every verdict.
      const routeIsOurs = route === "question" || route === "balancer";
      const gaveAReason = res.degradations.some((d) => d.includes(id)) || !routeIsOurs;
      const verdict = reply ? "ANSWERED" : gaveAReason ? "HANDED BACK" : "SILENT";
      if (verdict === "ANSWERED") answered++;
      else if (verdict === "HANDED BACK") handedBack++;
      else silent++;

      const wrong = verdict === "ANSWERED" && c.wants !== undefined && !c.wants.test(reply!);
      if (wrong) wrongAnswer++;
      if (verdict !== c.expect) mismatched++;

      console.log(
        `  ${repeat > 1 ? `run ${n + 1}/${repeat}  ` : ""}route=${route.padEnd(9)} ` +
          `${verdict}${verdict !== c.expect ? `  ⚠️ expected ${c.expect}` : ""}` +
          `${wrong ? `  ⚠️ answer does not match ${c.wants}` : ""}`,
      );
      if (reply) console.log(`  says   : ${JSON.stringify(reply.slice(0, 160))}`);
      else if (!routeIsOurs) console.log(`  reason : the router sent it to "${route}", which step 7 does not own`);
      else if (res.degradations.length) console.log(`  reason : ${res.degradations.join(" | ")}`);
    }
  }

  console.log(
    `\n${"═".repeat(72)}\n` +
      `${selected.length} question(s) × ${repeat} = ${runs} run(s).\n` +
      `  ANSWERED    ${answered} of ${runs}\n` +
      `  HANDED BACK ${handedBack} of ${runs}  (the analyzer answers these in production)\n` +
      `  SILENT      ${silent} of ${runs}${silent === 0 ? "  ✅" : "  ❌ this must be 0"}\n` +
      `  answers not matching their wants-pattern: ${wrongAnswer}\n` +
      `  verdicts differing from expect:           ${mismatched}\n` +
      `Total cost: $${totalUsd.toFixed(4)}. Writes performed: 0 (this harness cannot write).`,
  );
}

async function main(): Promise<void> {
  const groupId = process.env.ORG_GROUP ?? DEFAULT_GROUP;
  const org = await db.organisation.findFirst({
    where: { whatsappGroupId: groupId },
    select: { id: true, name: true },
  });
  if (!org) throw new Error(`no organisation with whatsappGroupId ${groupId}`);

  if (process.env.CHASES === "1") {
    await runChases(groupId);
    await db.$disconnect();
    return;
  }

  const now = new Date();
  const base = await loadSquadState(org.id, now);
  console.log(
    `ORG   : ${org.name}\n` +
      `MATCH : ${base.matchId ?? "(none)"} — ${base.kickoffLabel} at ${base.venue}\n` +
      `STATE : ${describeSquad(base)}\n`,
  );

  if (process.env.QUESTIONS === "1") {
    await runQuestions(org.id, base, now);
    await db.$disconnect();
    return;
  }

  const only = process.env.ONLY?.split(",").map((s) => s.trim());
  const repeat = Math.max(1, Number(process.env.REPEAT ?? 1));
  const showFacts = process.env.FACTS === "1" || repeat === 1;
  let totalUsd = 0;
  let unstable = 0;
  let ran = 0;

  // Resolve every sender up front so a stale name fails before any
  // money is spent, not two minutes into a 15-repeat sweep.
  const selected = CASES.filter((c) => !only || only.includes(c.id));
  if (only) {
    const unknown = only.filter((id) => !CASES.some((c) => c.id === id));
    if (unknown.length) throw new Error(`ONLY names no such case: ${unknown.join(", ")}`);
  }
  const senders = new Map(selected.map((c) => [c.id, memberByName(base.roster, c.who)]));

  for (const c of selected) {
    const sender = senders.get(c.id)!;
    const signatures: string[] = [];
    console.log(
      `\n${"─".repeat(72)}\n${c.id}  ${sender.name}` +
        `${c.tagged ? " [@tagged]" : ""}${c.fullSquad ? " [FULL SQUAD]" : ""}` +
        `: ${JSON.stringify(c.body)}\n  expect : ${c.expect}`,
    );

    for (let n = 0; n < repeat; n++) {
      const state = c.fullSquad
        ? fillSquad(
            base,
            c.squadIncludes ?? FULL_SQUAD_INCLUDES,
            c.benched ?? FULL_SQUAD_BENCH,
          )
        : structuredClone(base);
      let r;
      try {
        r = await runPipeline({
          messages: [
            {
              id: `${c.id}-${n}`,
              body: c.body,
              authorName: c.as ?? sender.name,
              senderUserId: sender.userId,
              senderName: c.as ?? sender.name,
              tagged: c.tagged ?? false,
            },
          ],
          history: HISTORY,
          state,
          now,
        });
      } catch (err) {
        console.log(`  💥 THREW: ${(err as Error).message}`);
        signatures.push("threw");
        continue;
      }
      ran++;
      totalUsd += r.cost.totalUsd;

      const writes = r.engine.writes.map((w) =>
        w.kind === "attendance"
          ? `${w.status} ${w.name}${w.explicitBench ? " (explicit bench)" : ""} — ${w.reason}`
          : `${w.kind} — ${w.reason}`,
      );
      if (repeat > 1) console.log(`  ── run ${n + 1}/${repeat}`);
      console.log(`  route  : ${r.routes[0]?.route ?? "?"}`);
      if (showFacts) {
        const claim = (r.facts[0]?.facts as { claims?: Array<Record<string, unknown>> })?.claims?.[0];
        console.log(
          claim
            ? `  claim  : basis=${claim.basis} contingent=${claim.contingent} ` +
                `conditionOn=${claim.conditionOn} polarity=${claim.polarity} ` +
                `conf=${claim.confidence} -> ${r.engine.writes.length ? "WRITE" : "no write"}`
            : `  facts  : ${JSON.stringify(r.facts[0]?.facts ?? null)}`,
        );
      }
      console.log(`  reasons: ${r.engine.outcomes[0]?.reasons.join(" | ") ?? "(none)"}`);
      console.log(`  writes : ${writes.length ? writes.join(" | ") : "(none)"}`);
      console.log(
        `  says   : ${
          r.composed.utterances.length
            ? r.composed.utterances.map((u) => JSON.stringify(u.text)).join(" | ")
            : "(silent)"
        }`,
      );
      if (r.composed.reacts.length) {
        console.log(`  reacts : ${r.composed.reacts.map((x) => x.emoji).join(" ")}`);
      }
      if (r.degradations.length) {
        console.log(`  DEGRADED: ${r.degradations.map((d) => d.detail).join(" | ")}`);
      }
      if (r.composed.operatorNotes.length) {
        console.log(`  opnotes: ${r.composed.operatorNotes.join(" | ")}`);
      }
      console.log(`  cost   : $${r.cost.totalUsd.toFixed(5)}`);

      signatures.push(
        JSON.stringify({
          route: r.routes[0]?.route,
          writes: r.engine.writes
            .map((w) => `${w.kind}:${"name" in w ? w.name : ""}:${"status" in w ? w.status : ""}`)
            .sort(),
          spoke: r.composed.utterances.length > 0,
        }),
      );
    }

    if (signatures.length > 1) {
      const variants = [...new Set(signatures)];
      const stable = variants.length === 1;
      if (!stable) unstable++;
      console.log(
        `  STABILITY: ${stable ? "✅ STABLE" : "⚠️  UNSTABLE"} across ${signatures.length} runs` +
          ` — ${variants.length} distinct outcome(s)`,
      );
      if (!stable) {
        variants
          .map((v) => ({ v, n: signatures.filter((s) => s === v).length }))
          .sort((a, b) => b.n - a.n)
          .forEach(({ v, n }, i) =>
            console.log(`     variant ${i + 1} (${n}/${signatures.length}): ${v}`),
          );
      }
    }
  }

  console.log(
    `\n${"═".repeat(72)}\n` +
      `${selected.length} case(s) × ${repeat} = ${ran} run(s). ` +
      `${unstable === 0 ? "No unstable cases." : `⚠️  ${unstable} UNSTABLE case(s).`}\n` +
      `Total cost: $${totalUsd.toFixed(4)}. Writes performed: 0 (this harness cannot write).`,
  );
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
