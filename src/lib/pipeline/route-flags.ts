/**
 * §10 STEP 7 — ONE FLAG PER ROUTE.
 *
 *   "Migrate the rest — `question`, `team_ops`, `score`, `admin_ops`,
 *    one per week. Retire the mega-prompt when the last route leaves."
 *    risk: low each.  revert: PER-ROUTE FLAG.
 *
 * Step 5 shipped one flag (`ROUTER_GATE_ENABLED`) and step 6 shipped a
 * second (`ATTENDANCE_ENGINE_ENABLED`) covering three routes at once,
 * because those three are one decision: they all end in an attendance
 * write and share every capacity, authorisation and corroboration rule.
 * The four routes left are NOT one decision. A question is a read, a
 * team post is a different read, a score is a write against a finished
 * match and a payment credit is real money on a live club. Reverting one
 * must not revert the others, so each gets its own switch — which is
 * what §10's revert column asks for, in those words.
 *
 * ─────────────────────────────────────────────────────────────────────
 * ALL FOUR FLAGS NOW EXIST — AND THAT IS A CLAIM, NOT A TIDY-UP
 * ─────────────────────────────────────────────────────────────────────
 * Part 1 shipped two and RESERVED the other two as constants nothing
 * read, because `gate.ts:227` states the rule this file obeys: a flag
 * that looks enabled and does nothing is "the worst kind of flag".
 *
 * Part 2 promotes them, and the rule is the reason it may: `score` and
 * `admin_ops` now have owners — `score-engine-batch.ts` and
 * `admin-ops-engine-batch.ts`, each with its own apply layer — so
 * `SCORE_ENGINE_ENABLED=1` genuinely takes the route off the
 * mega-prompt. If either owner is ever deleted, its flag must go with
 * it in the same change.
 *
 * `route-flags.test.ts` asserts that each flag turns on EXACTLY its own
 * route, that all four are pairwise independent, and that step 5's and
 * step 6's flags cannot turn any of them on.
 *
 * ─────────────────────────────────────────────────────────────────────
 * DEFAULT OFF, AND IT CANNOT BE OTHERWISE
 * ─────────────────────────────────────────────────────────────────────
 * Same four spellings as `gate.ts`, same strictness, and a unit test
 * asserts the two readers agree — so a typo in a Vercel env var can
 * never turn a route over, and a value that turns the attendance engine
 * on cannot turn a step-7 route on as a side effect.
 */
import { readFileSync } from "node:fs";
import { ROUTER_STUB_FILE_ENV } from "./gate";
import type { Route } from "./types";

// ── The flags that exist ──────────────────────────────────────────────

/** §3.2 S16 — the single heaviest section of the mega-prompt at 2,010
 *  measured tokens (`message-analyzer.ts:454-464`), six sub-rules, four
 *  incidents. Unset or `0` and every question goes back to it. */
export const QUESTION_FLAG = "QUESTION_ENGINE_ENABLED";

/** §3.2 S19 — "show the teams again" re-ran the balancer and destroyed
 *  an admin's manual swap (`c408649`). 331 measured tokens
 *  (`message-analyzer.ts:484-486`). This flag owns SHOWING only; see
 *  `answer-batch.ts` on why generating stays with the analyzer. */
export const BALANCER_FLAG = "BALANCER_ENGINE_ENABLED";

// ── The two flags part 2 promoted from RESERVED to real ──────────────

/**
 * §3.2 S17. The `score` route, and the FIRST step-7 flag that owns a
 * WRITE: `Match.redScore` / `yellowScore` plus the Elo deltas
 * (`route.ts:3505-3531`, `elo.ts:34`).
 *
 * Until part 2 this name was RESERVED — written down, read by nothing —
 * because `gate.ts:227` calls a flag that looks enabled and does nothing
 * "the worst kind of flag" and there was no owner. `score-engine-batch.ts`
 * is the owner, so the name is now honoured. The spelling is the one that
 * was reserved, which is the entire point of having reserved it.
 */
export const SCORE_FLAG = "SCORE_ENGINE_ENABLED";

/**
 * §3.2 S21 + S22. The `admin_ops` route: a payment credit (real money,
 * live on Sutton FC since 2026-06-09), a personal reminder, and the
 * recruit blast.
 *
 * ONE flag for all three, unlike the rest of step 7's one-per-route
 * scheme, because they are one ROUTE. Splitting them further would mean
 * a router verdict of `admin_ops` whose ownership depended on a fact the
 * extractor had not returned yet — the flag would have to be consulted
 * after the model call rather than before it, and the "own nothing
 * cheaply" property that makes every carve-out free would be gone.
 * `admin-ops-engine-batch.ts` decides per action instead, and each
 * action's carve-outs are enumerated there.
 */
export const ADMIN_OPS_FLAG = "ADMIN_OPS_ENGINE_ENABLED";

/**
 * The routes step 7 can own, in flag order.
 *
 * `unsure` is absent for the same reason `gate.ts:124` leaves it out of
 * the attendance engine: a route the router itself could not settle is
 * doubt, and §13's conservative default makes doubt cost an analyzer
 * call. `none` is step 5's business and is never owned by anything that
 * speaks.
 */
export const STEP_SEVEN_ROUTES: readonly Route[] = [
  "question",
  "balancer",
  "score",
  "admin_ops",
];

// ── WHICH OWNER OWNS WHICH ROUTE ─────────────────────────────────────
//
// Step 7 is no longer one module. `answer-batch.ts` owns the two READS
// and has no apply layer at all — a property `__tests__/zero-writes.test.ts`
// enforces by scanning the directory. The two routes below WRITE, so
// they live outside `pipeline/` with an apply layer each, exactly as
// step 6's `attendance-engine.ts` does.
//
// These lists exist so a runner cannot accidentally own a route it has
// no handler for. Without them, `enabledStepSevenRoutes` returning
// `{score}` and `answer-batch.ts` filtering only on `enabled.has(route)`
// would make the answer engine pay for an extractor call on every score
// message and then own none of them — which is not a bug that shows up
// as a failure, only as a bill.

/** Owned by `answer-batch.ts`. Reads; no apply layer; no writes. */
export const ANSWER_ENGINE_ROUTES: readonly Route[] = ["question", "balancer"];

/** Owned by `score-engine-batch.ts`. Writes, via `score-engine.ts`. */
export const SCORE_ENGINE_ROUTES: readonly Route[] = ["score"];

/** Owned by `admin-ops-engine-batch.ts`. Writes, via `admin-ops-engine.ts`. */
export const ADMIN_OPS_ENGINE_ROUTES: readonly Route[] = ["admin_ops"];

type Env = Record<string, string | undefined>;

/**
 * Deliberately strict, and deliberately a COPY of `gate.ts`'s private
 * `on()` rather than an import of it.
 *
 * Two reasons, and the second is the load-bearing one. First, `on()` is
 * not exported. Second, this module and `gate.ts` are edited by
 * different changes for different reasons, and a shared mutable helper
 * is how "we loosened the spelling for one flag" quietly loosens it for
 * all of them. `__tests__/route-flags.test.ts` asserts the two readers
 * agree on the same 40 inputs, which is a stronger guarantee than a
 * shared function: it fails loudly if either one drifts.
 */
function on(env: Env, key: string): boolean {
  const raw = env[key]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

// ── The test seams ────────────────────────────────────────────────────

/**
 * TEST-ONLY per-request override, for the one thing an env var cannot
 * do: a LIVE A/B in one process.
 *
 * Identical shape, identical double gate and identical blast radius to
 * `gate.ts`'s `x-mt-attendance-engine` (`gate.ts:197-209`):
 *
 *   1. `MT_TEST_MODE` must be exactly "1". Nothing sets that but
 *      `e2e/helpers/env.ts:buildTestEnv()` — it is not in
 *      `.env.example`, not in Vercel and not on the Pi.
 *   2. Anything unrecognised yields `null` and the caller falls back to
 *      the env flags, which are off.
 *
 * The VALUE is a comma-separated route list rather than a boolean,
 * because step 7's whole point is that the routes move one at a time
 * and an A/B has to be able to say WHICH one moved. Unknown names are
 * dropped rather than throwing: a header cannot invent a route.
 */
export const STEP_SEVEN_HEADER = "x-mt-engine-routes";

export function routesHeaderOverride(
  header: string | null | undefined,
  env: Env = process.env,
): Set<Route> | null {
  if (env.MT_TEST_MODE !== "1") return null;
  const raw = header?.trim().toLowerCase();
  if (raw === undefined || raw === "") return null;
  // An explicit "none" is how an arm says "own nothing" without falling
  // back to the env — the baseline arm of an A/B needs to be able to
  // state that rather than rely on the server's flags happening to be
  // off.
  if (raw === "none" || raw === "off" || raw === "0") return new Set();
  const wanted = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const routes = new Set<Route>();
  const unknown: string[] = [];
  for (const w of wanted) {
    const match = STEP_SEVEN_ROUTES.find((r) => r === w);
    if (match) routes.add(match);
    else unknown.push(w);
  }
  // A mistyped arm is the shape PR #38 exists to stop: it would own
  // nothing, score whatever the baseline scores, and report itself as
  // the candidate. It cannot throw from a request path, so it says so
  // instead — loudly enough that a sweep's log carries the reason its
  // numbers look like the incumbent's.
  if (unknown.length > 0) {
    console.warn(
      `[route-flags] ${STEP_SEVEN_HEADER} named ${unknown.length} route(s) step 7 cannot own ` +
        `(${unknown.join(", ")}); they were ignored. Valid: ${STEP_SEVEN_ROUTES.join(", ")}.`,
    );
  }
  return routes;
}

interface RouteStubConfig {
  /** Routes step 7 owns for this request. Same seam, same blast radius
   *  as `gate.ts`'s `engine` field: only ever read when
   *  MT_TEST_ROUTER_STUB_FILE is set, which nothing outside the e2e
   *  harness sets. */
  engineRoutes?: string[];
}

/**
 * Read fresh on every call, like the router stub, so a spec can rewrite
 * it between requests. It reads the SAME file `gate.ts` reads, under the
 * same env var, so one stub JSON configures the whole pipeline for a
 * spec rather than two files that can disagree about which request they
 * are describing.
 */
function routeStubConfig(env: Env = process.env): RouteStubConfig | null {
  const file = env[ROUTER_STUB_FILE_ENV];
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RouteStubConfig;
  } catch {
    // Missing or garbled → behave as if there were no stub at all, which
    // means the env flags, which are off, which means every message
    // reaches the analyzer. The direction that cannot lose a reply.
    return null;
  }
}

// ── The decision ──────────────────────────────────────────────────────

/**
 * Which of step 7's routes are live for this request?
 *
 * Precedence, highest first: the test-only header, the test-only stub
 * file, the environment. Exactly the order `gate.ts` uses, so an
 * operator reading one file understands both.
 */
export function enabledStepSevenRoutes(
  env: Env = process.env,
  headerOverride: Set<Route> | null = null,
): Set<Route> {
  if (headerOverride) return new Set(headerOverride);

  const stub = routeStubConfig(env);
  if (stub && Array.isArray(stub.engineRoutes)) {
    const routes = new Set<Route>();
    for (const raw of stub.engineRoutes) {
      const match = STEP_SEVEN_ROUTES.find((r) => r === String(raw).trim().toLowerCase());
      if (match) routes.add(match);
    }
    return routes;
  }

  const routes = new Set<Route>();
  if (on(env, QUESTION_FLAG)) routes.add("question");
  if (on(env, BALANCER_FLAG)) routes.add("balancer");
  if (on(env, SCORE_FLAG)) routes.add("score");
  if (on(env, ADMIN_OPS_FLAG)) routes.add("admin_ops");
  return routes;
}

/**
 * Does step 7 decide this route for this request?
 *
 * A route it has never heard of — including `undefined`, which is what a
 * message the router never mentioned looks like — is never owned.
 *
 * `within` narrows the answer to the routes ONE OWNER can actually
 * handle, and every caller passes it. It is optional only so the
 * unqualified question ("is this route live at all?") stays askable; a
 * runner that omitted it would happily claim a route whose facts it has
 * no branch for, spend an extractor call on it and then own nothing.
 */
export function stepSevenOwnsRoute(
  route: Route | undefined,
  enabled: Set<Route>,
  within?: readonly Route[],
): boolean {
  if (route === undefined) return false;
  if (within && !within.includes(route)) return false;
  return enabled.has(route);
}

/**
 * Must the router run for step 7's sake?
 *
 * The same trap `gate.ts:227` documents: turning a route flag on
 * without the router running would own nothing while looking enabled.
 * The analyze route ORs this with `routerIsNeeded`.
 */
export function stepSevenNeedsRouter(enabled: Set<Route>): boolean {
  return enabled.size > 0;
}
