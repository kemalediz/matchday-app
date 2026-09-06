/**
 * §10 STEP 7 — "revert: per-route flag", asserted rather than asserted-in-prose.
 *
 * Three properties, and each one is a bug that has already happened
 * somewhere in this migration:
 *
 *   1. DEFAULT OFF. Step 6's flag test exists because a flag that
 *      defaults on is a production change disguised as a refactor.
 *   2. INDEPENDENCE. Step 5 and step 6 got separate flags precisely so a
 *      revert of one is not a revert of the other (`gate.ts:104-108`).
 *      Four routes migrating one per week need the same property
 *      pairwise, and a shared `on()` helper would not give it — a
 *      loosened spelling would loosen all of them at once.
 *   3. A FLAG ONLY EXISTS ONCE IT OWNS ITS ROUTE. Part 1 kept
 *      `SCORE_ENGINE_ENABLED` and `ADMIN_OPS_ENGINE_ENABLED` as reserved
 *      names nothing read; part 2 honours them because
 *      `score-engine-batch.ts` and `admin-ops-engine-batch.ts` exist.
 *      The tests below assert both halves: the reserved SPELLINGS were
 *      the ones adopted, and each flag turns on exactly its own route.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import { isAttendanceEngineEnabled, isRouterGateEnabled, routerIsNeeded } from "../gate";
import {
  ADMIN_OPS_ENGINE_ROUTES,
  ADMIN_OPS_FLAG,
  ANSWER_ENGINE_ROUTES,
  BALANCER_FLAG,
  QUESTION_FLAG,
  SCORE_ENGINE_ROUTES,
  SCORE_FLAG,
  STEP_SEVEN_HEADER,
  STEP_SEVEN_ROUTES,
  enabledStepSevenRoutes,
  routesHeaderOverride,
  stepSevenNeedsRouter,
  stepSevenOwnsRoute,
} from "../route-flags";
import type { Route } from "../types";

const ON = ["1", "true", "yes", "on", "ON", " Yes ", "TRUE"];
const OFF = [
  undefined,
  "",
  " ",
  "0",
  "false",
  "no",
  "off",
  "maybe",
  "yes please",
  "enabled",
  "2",
  "-1",
  "null",
];

describe("step 7 per-route flags", () => {
  it("owns nothing at all with an empty environment", () => {
    expect([...enabledStepSevenRoutes({})]).toEqual([]);
    expect(stepSevenNeedsRouter(enabledStepSevenRoutes({}))).toBe(false);
  });

  it("owns nothing when the process environment is whatever it happens to be", () => {
    // The real `process.env` of a dev machine or CI runner. If this ever
    // starts returning routes, something has put a step-7 flag into a
    // shell profile or a .env that the test suite inherits — which is
    // exactly the accident the strict spellings exist to catch.
    expect([...enabledStepSevenRoutes()]).toEqual([]);
  });

  it.each(ON)("QUESTION_ENGINE_ENABLED=%s turns on `question` and nothing else", (v) => {
    const routes = enabledStepSevenRoutes({ [QUESTION_FLAG]: v });
    expect([...routes]).toEqual(["question"]);
    expect(stepSevenOwnsRoute("question", routes)).toBe(true);
    expect(stepSevenOwnsRoute("balancer", routes)).toBe(false);
  });

  it.each(OFF)("QUESTION_ENGINE_ENABLED=%s leaves it off", (v) => {
    expect([...enabledStepSevenRoutes({ [QUESTION_FLAG]: v })]).toEqual([]);
  });

  it.each(ON)("BALANCER_ENGINE_ENABLED=%s turns on `balancer` and nothing else", (v) => {
    const routes = enabledStepSevenRoutes({ [BALANCER_FLAG]: v });
    expect([...routes]).toEqual(["balancer"]);
    expect(stepSevenOwnsRoute("balancer", routes)).toBe(true);
    expect(stepSevenOwnsRoute("question", routes)).toBe(false);
  });

  it.each(OFF)("BALANCER_ENGINE_ENABLED=%s leaves it off", (v) => {
    expect([...enabledStepSevenRoutes({ [BALANCER_FLAG]: v })]).toEqual([]);
  });

  it("the two flags are independent in both directions", () => {
    expect([...enabledStepSevenRoutes({ [QUESTION_FLAG]: "1", [BALANCER_FLAG]: "0" })]).toEqual([
      "question",
    ]);
    expect([...enabledStepSevenRoutes({ [QUESTION_FLAG]: "0", [BALANCER_FLAG]: "1" })]).toEqual([
      "balancer",
    ]);
    expect(
      [...enabledStepSevenRoutes({ [QUESTION_FLAG]: "1", [BALANCER_FLAG]: "1" })].sort(),
    ).toEqual(["balancer", "question"]);
  });

  it("step 5 and step 6's flags cannot turn a step-7 route on", () => {
    expect([
      ...enabledStepSevenRoutes({ ROUTER_GATE_ENABLED: "1", ATTENDANCE_ENGINE_ENABLED: "1" }),
    ]).toEqual([]);
  });

  it("a step-7 flag cannot turn step 5 or step 6 on", () => {
    const env = { [QUESTION_FLAG]: "1", [BALANCER_FLAG]: "1" };
    expect(isRouterGateEnabled(env)).toBe(false);
    expect(isAttendanceEngineEnabled(env)).toBe(false);
  });

  it("reads exactly the same spellings as gate.ts, so neither can drift", () => {
    for (const v of [...ON, ...OFF]) {
      const mine = enabledStepSevenRoutes({ [QUESTION_FLAG]: v }).has("question");
      const theirs = isAttendanceEngineEnabled({ ATTENDANCE_ENGINE_ENABLED: v });
      expect(
        mine,
        `"${v}" is read as ${mine} by route-flags.ts and ${theirs} by gate.ts`,
      ).toBe(theirs);
    }
  });

  it.each(ON)("SCORE_ENGINE_ENABLED=%s turns on `score` and nothing else", (v) => {
    const routes = enabledStepSevenRoutes({ [SCORE_FLAG]: v });
    expect([...routes]).toEqual(["score"]);
    expect(stepSevenOwnsRoute("score", routes, SCORE_ENGINE_ROUTES)).toBe(true);
    expect(stepSevenOwnsRoute("admin_ops", routes)).toBe(false);
  });

  it.each(OFF)("SCORE_ENGINE_ENABLED=%s leaves it off", (v) => {
    expect([...enabledStepSevenRoutes({ [SCORE_FLAG]: v })]).toEqual([]);
  });

  it.each(ON)("ADMIN_OPS_ENGINE_ENABLED=%s turns on `admin_ops` and nothing else", (v) => {
    const routes = enabledStepSevenRoutes({ [ADMIN_OPS_FLAG]: v });
    expect([...routes]).toEqual(["admin_ops"]);
    expect(stepSevenOwnsRoute("admin_ops", routes, ADMIN_OPS_ENGINE_ROUTES)).toBe(true);
    expect(stepSevenOwnsRoute("score", routes)).toBe(false);
  });

  it.each(OFF)("ADMIN_OPS_ENGINE_ENABLED=%s leaves it off", (v) => {
    expect([...enabledStepSevenRoutes({ [ADMIN_OPS_FLAG]: v })]).toEqual([]);
  });

  it("all four flags are pairwise independent", () => {
    // §10's revert column is "per-route flag" in those words. Reverting
    // the money must not revert the reads, and vice versa.
    const FLAGS = [QUESTION_FLAG, BALANCER_FLAG, SCORE_FLAG, ADMIN_OPS_FLAG];
    const ROUTE_OF: Record<string, Route> = {
      [QUESTION_FLAG]: "question",
      [BALANCER_FLAG]: "balancer",
      [SCORE_FLAG]: "score",
      [ADMIN_OPS_FLAG]: "admin_ops",
    };
    for (const flag of FLAGS) {
      const env = Object.fromEntries(FLAGS.map((f) => [f, f === flag ? "1" : "0"]));
      expect([...enabledStepSevenRoutes(env)]).toEqual([ROUTE_OF[flag]]);
    }
    const all = Object.fromEntries(FLAGS.map((f) => [f, "1"]));
    expect([...enabledStepSevenRoutes(all)].sort()).toEqual([
      "admin_ops",
      "balancer",
      "question",
      "score",
    ]);
  });

  it("each owner is scoped to the routes it has a handler for", () => {
    // The trap this replaces: with every flag on and no `within`
    // narrowing, `answer-batch.ts` would treat a `score` message as a
    // candidate, pay for a question-extractor call on it, find no branch
    // that matches, and own nothing. Not a failure — a bill.
    const all = enabledStepSevenRoutes({
      [QUESTION_FLAG]: "1",
      [BALANCER_FLAG]: "1",
      [SCORE_FLAG]: "1",
      [ADMIN_OPS_FLAG]: "1",
    });
    expect(stepSevenOwnsRoute("score", all, ANSWER_ENGINE_ROUTES)).toBe(false);
    expect(stepSevenOwnsRoute("admin_ops", all, ANSWER_ENGINE_ROUTES)).toBe(false);
    expect(stepSevenOwnsRoute("question", all, SCORE_ENGINE_ROUTES)).toBe(false);
    expect(stepSevenOwnsRoute("score", all, ADMIN_OPS_ENGINE_ROUTES)).toBe(false);
    // …and the three lists together are exactly step 7's routes, with no
    // route owned twice.
    const owners = [...ANSWER_ENGINE_ROUTES, ...SCORE_ENGINE_ROUTES, ...ADMIN_OPS_ENGINE_ROUTES];
    expect([...owners].sort()).toEqual([...STEP_SEVEN_ROUTES].sort());
    expect(new Set(owners).size).toBe(owners.length);
  });

  it("no flag name is left RESERVED — every one of them owns a route", () => {
    // Part 1 kept `SCORE_ENGINE_ENABLED` and `ADMIN_OPS_ENGINE_ENABLED`
    // as names nothing read, because `gate.ts:227` calls a flag that
    // looks enabled and does nothing "the worst kind of flag". Part 2
    // may honour them only because they now have owners. This asserts
    // the promotion actually happened and used the reserved spellings.
    expect(SCORE_FLAG).toBe("SCORE_ENGINE_ENABLED");
    expect(ADMIN_OPS_FLAG).toBe("ADMIN_OPS_ENGINE_ENABLED");
    expect([...enabledStepSevenRoutes({ [SCORE_FLAG]: "1" })]).toEqual(["score"]);
    expect([...enabledStepSevenRoutes({ [ADMIN_OPS_FLAG]: "1" })]).toEqual(["admin_ops"]);
  });

  it("only routes step 7 can actually own are listed", () => {
    expect([...STEP_SEVEN_ROUTES]).toEqual(["question", "balancer", "score", "admin_ops"]);
    // `unsure` is doubt and `none` is banter; neither is ever owned by
    // something that speaks (gate.ts:113-123 makes the same argument for
    // the attendance engine).
    expect(STEP_SEVEN_ROUTES).not.toContain("unsure");
    expect(STEP_SEVEN_ROUTES).not.toContain("none");
  });

  it("an undefined route — a message the router never mentioned — is never owned", () => {
    const routes = enabledStepSevenRoutes({ [QUESTION_FLAG]: "1", [BALANCER_FLAG]: "1" });
    expect(stepSevenOwnsRoute(undefined, routes)).toBe(false);
  });
});

describe("the test-only routes header", () => {
  const TEST = { MT_TEST_MODE: "1" };

  it("is inert unless MT_TEST_MODE is exactly 1", () => {
    expect(routesHeaderOverride("question", {})).toBeNull();
    expect(routesHeaderOverride("question", { MT_TEST_MODE: "0" })).toBeNull();
    expect(routesHeaderOverride("question", { MT_TEST_MODE: "true" })).toBeNull();
    expect(routesHeaderOverride("question", { MT_TEST_MODE: " 1" })).toBeNull();
  });

  it("falls back to the env when absent or empty", () => {
    expect(routesHeaderOverride(null, TEST)).toBeNull();
    expect(routesHeaderOverride(undefined, TEST)).toBeNull();
    expect(routesHeaderOverride("  ", TEST)).toBeNull();
  });

  it("selects one route, or several", () => {
    expect([...routesHeaderOverride("question", TEST)!]).toEqual(["question"]);
    expect([...routesHeaderOverride("balancer", TEST)!]).toEqual(["balancer"]);
    expect([...routesHeaderOverride("question,balancer", TEST)!].sort()).toEqual([
      "balancer",
      "question",
    ]);
    expect([...routesHeaderOverride(" QUESTION , balancer ", TEST)!].sort()).toEqual([
      "balancer",
      "question",
    ]);
  });

  it("states an empty selection explicitly, so a baseline arm can say `own nothing`", () => {
    expect([...routesHeaderOverride("none", TEST)!]).toEqual([]);
    expect([...routesHeaderOverride("off", TEST)!]).toEqual([]);
    expect([...routesHeaderOverride("0", TEST)!]).toEqual([]);
  });

  it("cannot invent a route", () => {
    // Not a step-7 route, not a route at all, and a route that belongs
    // to another step. None of them may be smuggled in through a header.
    for (const bad of ["self_att", "other_att", "offer", "unsure", "none", "teams", "banana"]) {
      expect([...routesHeaderOverride(bad, TEST)!]).toEqual([]);
    }
  });

  it("wins over the environment, in both directions", () => {
    const env = { ...TEST, [QUESTION_FLAG]: "1", [BALANCER_FLAG]: "1" };
    expect([...enabledStepSevenRoutes(env, routesHeaderOverride("none", TEST))]).toEqual([]);
    expect([...enabledStepSevenRoutes({ ...TEST }, routesHeaderOverride("question", TEST))]).toEqual(
      ["question"],
    );
  });

  it("is named so it cannot collide with step 6's header", () => {
    expect(STEP_SEVEN_HEADER).toBe("x-mt-engine-routes");
    expect(STEP_SEVEN_HEADER).not.toBe("x-mt-attendance-engine");
  });
});

describe("the stub-file seam", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-route-flags-"));
  const file = path.join(dir, "router-stub.json");
  const env = (extra: Record<string, string | undefined> = {}) => ({
    MT_TEST_ROUTER_STUB_FILE: file,
    ...extra,
  });
  const write = (cfg: unknown) => fs.writeFileSync(file, JSON.stringify(cfg));

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("is inert unless MT_TEST_ROUTER_STUB_FILE is set", () => {
    write({ engineRoutes: ["question"] });
    expect([...enabledStepSevenRoutes({})]).toEqual([]);
  });

  it("reads the SAME file gate.ts reads, so one stub configures the whole pipeline", () => {
    write({ enabled: true, engine: true, engineRoutes: ["question", "balancer"] });
    expect([...enabledStepSevenRoutes(env())].sort()).toEqual(["balancer", "question"]);
    expect(isRouterGateEnabled(env())).toBe(true);
    expect(isAttendanceEngineEnabled(env())).toBe(true);
  });

  it("a stub with no engineRoutes key falls through to the env, exactly as gate.ts does", () => {
    // `gate.ts:144` reads its own key as `typeof stub.enabled ===
    // "boolean"` and otherwise falls back to the env; this file matches
    // that convention rather than inventing a second one, and the two
    // are asserted side by side so neither can drift into the other's
    // shape. A spec that means "own nothing" says so with
    // `engineRoutes: []`.
    write({ enabled: true });
    expect([...enabledStepSevenRoutes(env({ [QUESTION_FLAG]: "1" }))]).toEqual(["question"]);
    expect([...enabledStepSevenRoutes(env())]).toEqual([]);
    expect(isRouterGateEnabled(env())).toBe(true);
    write({ enabled: true, engineRoutes: [] });
    expect([...enabledStepSevenRoutes(env({ [QUESTION_FLAG]: "1" }))]).toEqual([]);
  });

  it("cannot invent a route through the stub file either", () => {
    write({ engineRoutes: ["self_att", "banana", "question"] });
    expect([...enabledStepSevenRoutes(env())]).toEqual(["question"]);
  });

  it("a garbled stub file owns nothing rather than throwing", () => {
    fs.writeFileSync(file, "{ not json");
    expect(() => enabledStepSevenRoutes(env())).not.toThrow();
    expect([...enabledStepSevenRoutes(env())]).toEqual([]);
  });

  it("the header still wins over the stub file", () => {
    write({ engineRoutes: ["question", "balancer"] });
    expect([
      ...enabledStepSevenRoutes(env({ MT_TEST_MODE: "1" }), routesHeaderOverride("balancer", {
        MT_TEST_MODE: "1",
      })),
    ]).toEqual(["balancer"]);
  });
});

describe("the router has to run for a step-7 route to own anything", () => {
  it("says so, rather than owning nothing while looking enabled", () => {
    expect(stepSevenNeedsRouter(new Set())).toBe(false);
    expect(stepSevenNeedsRouter(new Set<Route>(["question"]))).toBe(true);
    expect(stepSevenNeedsRouter(new Set<Route>(["balancer"]))).toBe(true);
  });

  it("is the ONLY thing standing between a live flag and owning nothing", () => {
    // The trap, spelled out because it is not enforceable from here: a
    // stub file (or an env flag) can turn `question` on while
    // `ROUTER_GATE_ENABLED` and `ATTENDANCE_ENGINE_ENABLED` are both
    // off, in which case `routerIsNeeded` is false, the router never
    // runs, every route is `undefined`, and step 7 owns nothing while
    // its flag reads on. The wiring commit MUST OR this into
    // `routerIsNeeded`; this test is the reminder attached to the
    // reason.
    const env = { QUESTION_ENGINE_ENABLED: "1" };
    expect(isRouterGateEnabled(env)).toBe(false);
    expect(isAttendanceEngineEnabled(env)).toBe(false);
    expect(routerIsNeeded(env, false)).toBe(false);
    expect(stepSevenNeedsRouter(enabledStepSevenRoutes(env))).toBe(true);
  });
});
