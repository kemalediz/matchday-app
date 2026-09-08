/**
 * INCIDENT CORPUS — stubbed replay (deterministic, runs in CI).
 *
 * Replays every corpus case that carries a ROUTE through the real
 * `/api/whatsapp/analyze` route with the router and extractor seams
 * stubbed, and grades the DATABASE and what MatchTime said against the
 * known-correct outcome recorded in `e2e/corpus/incidents.jsonl`.
 *
 * A stub says what the ROUTER answered and what the EXTRACTOR found —
 * both properties of the message text. It never says what to do. Every
 * case therefore pins a DECISION the shipped code makes: capacity, the
 * interaction contract, authorisation, tense, contingency, the
 * confidence floor, the bench, the batch-final squad post.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT THE NUMBERS MEAN, AND THE ONE THAT WAS WRONG
 * ═══════════════════════════════════════════════════════════════════════
 *
 * MEASURED 2026-09-08: 35 of 35 stubbed cases pass, and 32 of the 35 fail
 * when the seam stops forwarding (measured by disabling the two lines in
 * `current-analyzer-pipeline.ts` that forward `route` and `facts`). The
 * three survivors are S2b and S21b, whose recorded outcome IS silence,
 * and S26, whose write comes from `reconcilePastedRoster` above the
 * router. 26 of the 35 change the database; 33 make MatchTime speak.
 *
 * WHAT THIS REPLACED. For two days every case carried a
 * `CorpusStubVerdict` and nothing was left that reads a verdict, so all
 * 36 ran against a server that routed nothing and said nothing: 10 of 36
 * "green", most of them expecting nothing to happen and getting it for
 * the wrong reason.
 *
 * ⚠️ THE `spurious_write 8` IN THAT SCOREBOARD WAS NOT REAL, and this
 * comment used to say the eight came from the deterministic fast paths
 * above the engine acting on messages nobody routed. They did not.
 * Re-measured on 2026-09-08, all eight had `attendanceBefore ===
 * attendanceAfter` — not one row moved — and exactly ONE case in the
 * whole sweep changed a single row (S26, correctly). The grader was
 * filing a MISSED DROP as a spurious write, because a drop that never
 * happens leaves the confirmed count above the expectation. `gradeCase`
 * now classifies against `attendanceBefore`, so "spurious" means a write
 * happened — which is what §10 step 3's go/no-go asks for.
 *
 * ── the original note, still true ───────────────────────────────────
 *
 * ⚠️ THIS SPEC ASSERTS AGAINST A RECORDED BASELINE, NOT AGAINST ALL-PASS.
 *
 * §4 of MDs/analyzer-redesign-2026-08-31.md documents that the analyzer
 * has not always done what it says, so a case is allowed to be EXPECTED
 * to fail. That is a finding about the pipeline, not a bug in the
 * corpus, and the corpus must never be weakened to make it green. The
 * baseline in `e2e/corpus/baseline.stub.json` records exactly which
 * cases pass today; this spec fails on any DIVERGENCE in either
 * direction, so a regression is caught AND a fix is noticed.
 *
 * Changing an expectation is allowed, and only with an `adjudication`
 * block written at the case saying why (README, rule 4).
 *
 *   npm run test:corpus          # this spec alone
 *   npm run test:e2e             # included in the full gate
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { test, expect, resetDb } from "../fixtures";
import { loadCorpus } from "../corpus/load";
import { CurrentAnalyzerPipeline } from "../corpus/current-analyzer-pipeline";
import { runCorpus, renderScoreboard, writeReport } from "../corpus/runner";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const BASELINE = path.join(process.cwd(), "e2e", "corpus", "baseline.stub.json");
/** Set when deliberately re-recording the baseline after a real change. */
const RECORD = process.env.MT_CORPUS_RECORD === "1";
/** Triage one case: MT_CORPUS_FILTER=S17 npm run test:corpus */
const FILTER = process.env.MT_CORPUS_FILTER;

interface Baseline {
  pipeline: string;
  note: string;
  cases: Record<string, "pass" | "fail" | "skip">;
}

// Skipped under MT_SIM_LIVE_LLM=1: that flag disables the stub seam for
// every sim spec, so a "stubbed" run there would silently be a live one.
(LIVE ? test.describe.skip : test.describe)("incident corpus — stubbed replay", () => {
  test.describe.configure({ mode: "default" });
  test.beforeAll(resetDb);

  test("every stubbable case replays, and the result matches the recorded baseline", async ({
    request,
    db,
  }) => {
    test.setTimeout(600_000);

    const cases = loadCorpus();
    const pipeline = new CurrentAnalyzerPipeline();
    const sb = await runCorpus({ request, db }, pipeline, cases, {
      mode: "stub",
      runs: 1,
      ...(FILTER ? { filter: FILTER } : {}),
      ...(FILTER
        ? {
            onObservation: (c, o) => {
              // eslint-disable-next-line no-console
              console.log(
                `[corpus] ${c.id}\n  before: ${JSON.stringify(o.attendanceBefore)}\n` +
                  `  after:  ${JSON.stringify(o.attendanceAfter)}\n` +
                  `  spoken: ${JSON.stringify(o.spoken)}\n` +
                  `  dms:    ${JSON.stringify(o.dms)}\n` +
                  `  reacts: ${JSON.stringify(o.reacts)}  offers: ${o.benchOffersOpen}\n` +
                  `  score:  ${JSON.stringify(o.scoreAfter)}  teams: ${JSON.stringify(o.teamsAfter)}`,
              );
            },
          }
        : {}),
    });

    // eslint-disable-next-line no-console
    console.log(renderScoreboard(sb));
    const file = writeReport({
      pipeline: pipeline.name,
      mode: "stub",
      runsPerCase: 1,
      generatedAt: new Date().toISOString(),
      scoreboard: sb,
    });
    // eslint-disable-next-line no-console
    console.log(`[corpus] machine-readable report → ${file}`);

    const observed: Record<string, "pass" | "fail" | "skip"> = {};
    for (const c of sb.cases) {
      observed[c.caseId] = c.skipped ? "skip" : c.passes === c.runs ? "pass" : "fail";
    }

    if (FILTER) {
      // A filtered run is a triage tool, not a gate — comparing a
      // 1-case run against a 46-case baseline would report 45 phantom
      // regressions.
      // eslint-disable-next-line no-console
      console.log(`[corpus] filtered run (MT_CORPUS_FILTER=${FILTER}) — baseline NOT compared`);
      return;
    }

    if (RECORD || !existsSync(BASELINE)) {
      // eslint-disable-next-line no-console
      console.log(
        "[corpus] BASELINE (copy into e2e/corpus/baseline.stub.json):\n" +
          JSON.stringify(observed, null, 2),
      );
      expect(existsSync(BASELINE), "no baseline recorded yet — see the block above").toBe(true);
      return;
    }

    const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;
    const regressions: string[] = [];
    const improvements: string[] = [];
    for (const [id, want] of Object.entries(baseline.cases)) {
      const got = observed[id];
      if (got === undefined) {
        regressions.push(`${id}: in the baseline but no longer in the corpus`);
      } else if (got !== want) {
        (want === "pass" ? regressions : improvements).push(`${id}: ${want} → ${got}`);
      }
    }
    for (const id of Object.keys(observed)) {
      if (!(id in baseline.cases)) improvements.push(`${id}: new case, not in the baseline`);
    }

    expect(
      regressions.join(" | "),
      "a corpus case that used to pass no longer does — fix the analyzer, never the case",
    ).toBe("");
    expect(
      improvements.join(" | "),
      "cases now behave better (or the corpus grew). Re-record with " +
        "MT_CORPUS_RECORD=1 and commit the new baseline.",
    ).toBe("");
  });
});
