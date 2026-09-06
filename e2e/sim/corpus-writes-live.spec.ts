/**
 * INCIDENT CORPUS — pipeline #5, §10 STEP 7 PART 2's two WRITING routes
 * (`score` and `admin_ops`) against the real model.
 *
 *   set -a; source .env; set +a
 *   npm run test:corpus:writes                          # 3 runs per case
 *   MT_SIM_RUNS=1 npm run test:corpus:writes             # one pass, cheap
 *   MT_CORPUS_FILTER=S21 npm run test:corpus:writes      # one case, verbose
 *
 * The comparison is against `npm run test:corpus:live` (the incumbent)
 * on the SAME case ids. The blocker is one line: *any case the old path
 * passes and this one fails*. Both arms write a machine-readable report,
 * so that comparison is a diff and not a reading of two terminals.
 *
 * REPORTING, NOT GATING, like the other live sweeps — with two
 * exceptions that are about whether a measurement HAPPENED rather than
 * about whether it was good:
 *
 *   1. the sweep must have produced runs;
 *   2. it must have billed something. This pipeline is in-process and
 *      writes no `AnalyzedMessage` rows, so `liveReachFailure` has
 *      nothing to read; measured spend is the direct evidence that the
 *      router and the extractors were really called. PR #38's point was
 *      that a sweep which cannot reach the model must FAIL rather than
 *      score whatever an all-silent analyzer scores, and a $0.0000
 *      sweep is exactly that shape.
 *
 * UNLIKE the answer-engine sweep, this pipeline WRITES: the apply layers
 * record scores, move ratings, stamp `paidAt`, create `PaymentCredit`
 * rows and queue reminder DMs against the corpus database. So
 * `attendanceAfter`, `scoreAfter` and `dms` are real reads, and a case
 * asserting `unchanged` is asserting that nothing moved.
 *
 * NEVER weaken a corpus expectation to make this green.
 */
import path from "node:path";
import { test, expect, resetDb } from "../fixtures";
import { loadCorpus } from "../corpus/load";
import { WriteRoutesPipeline } from "../corpus/write-routes-pipeline";
import { runCorpus, renderScoreboard, writeReport } from "../corpus/runner";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const RUNS = Number(process.env.MT_SIM_RUNS ?? 3);
const FILTER = process.env.MT_CORPUS_FILTER;
const MIN_PASS = process.env.MT_CORPUS_MIN_PASS ? Number(process.env.MT_CORPUS_MIN_PASS) : null;

(LIVE ? test.describe : test.describe.skip)(
  "incident corpus LIVE — the write routes (score + admin_ops)",
  () => {
    test.describe.configure({ mode: "default" });
    test.beforeAll(resetDb);

    test(`replays the owned cases ×${RUNS} through the write routes`, async ({ request, db }) => {
      test.setTimeout(60 * 60_000);

      const cases = loadCorpus();
      const pipeline = new WriteRoutesPipeline();
      let costUsd = 0;
      let batches = 0;
      let handedBack = 0;
      let owned = 0;
      // The recruit ask is DEFERRED, not fired here, so the grader has
      // nothing textual to judge it on. What can be measured is whether
      // the ask was RECOGNISED at all — the exact thing that only the
      // mega-prompt could do before this change — so it is counted
      // explicitly and reported rather than inferred from a pass rate.
      let recruitRecognised = 0;
      let recruitRuns = 0;
      const recruitLookbacks: Array<number | null> = [];

      const sb = await runCorpus({ request, db }, pipeline, cases, {
        mode: "live",
        runs: RUNS,
        ...(FILTER ? { filter: FILTER } : {}),
        onObservation: (c, o) => {
          const n = o.notes as
            | {
                costUsd?: number;
                routes?: unknown[];
                owned?: string[];
                handedBack?: string[];
                reasons?: unknown[];
                recruit?: Array<{ lookbackMatches: number | null }>;
                degradations?: string[];
              }
            | undefined;
          if (typeof n?.costUsd === "number") {
            costUsd += n.costUsd;
            batches += 1;
          }
          owned += n?.owned?.length ?? 0;
          handedBack += n?.handedBack?.length ?? 0;
          if (c.id === "ADMIN-recruit-blast-from-the-last-n-matches") {
            recruitRuns += 1;
            if ((n?.recruit?.length ?? 0) > 0) {
              recruitRecognised += 1;
              recruitLookbacks.push(n!.recruit![0].lookbackMatches);
            }
          }
          if (FILTER) {
            console.log(
              `[corpus-writes] ${c.id}\n` +
                `  routes:      ${JSON.stringify(n?.routes)}\n` +
                `  owned:       ${JSON.stringify(n?.owned)}\n` +
                `  handed back: ${JSON.stringify(n?.handedBack)}\n` +
                `  reasons:     ${JSON.stringify(n?.reasons)}\n` +
                `  recruit:     ${JSON.stringify(n?.recruit)}\n` +
                `  score:       ${JSON.stringify(o.scoreAfter)}\n` +
                `  spoken:      ${JSON.stringify(o.spoken)}\n` +
                `  dms:         ${JSON.stringify(o.dms)}\n` +
                `  degrade:     ${JSON.stringify(n?.degradations)}`,
            );
          }
        },
        onCase: (s) => {
          if (s.skipped) return;
          console.log(
            `[corpus-writes] ${s.passes}/${s.runs} ${s.caseId}` +
              (s.failures?.length ? `\n              ↳ ${s.failures.slice(0, 4).join(" | ")}` : ""),
          );
        },
      });

      console.log(renderScoreboard(sb));
      console.log(
        `[corpus-writes] ${owned} message(s) owned, ${handedBack} handed back to the analyzer ` +
          `(a hand-back is a documented carve-out, not a failure).`,
      );
      if (recruitRuns > 0) {
        console.log(
          `[corpus-writes] recruit ask recognised in ${recruitRecognised}/${recruitRuns} runs ` +
            `(lookbacks: ${JSON.stringify(recruitLookbacks)}). Before this change the engine ` +
            `returned \`admin action "other" has no deterministic handler\` for every one of them.`,
        );
      }
      console.log(
        `[corpus-writes] measured cost: $${costUsd.toFixed(4)} over ${batches} batches ` +
          `= $${batches > 0 ? (costUsd / batches).toFixed(5) : "0"} per batch ` +
          `(router + up to two extractor calls).`,
      );

      const file = writeReport(
        {
          pipeline: pipeline.name,
          mode: "live",
          runsPerCase: RUNS,
          generatedAt: new Date().toISOString(),
          scoreboard: sb,
        },
        path.join(process.cwd(), ".e2e", "corpus", "report-live-writes.json"),
      );
      console.log(`[corpus-writes] machine-readable report → ${file}`);

      expect(sb.totals.runs, "the write-routes sweep produced no results at all").toBeGreaterThan(0);
      expect(
        costUsd,
        "the write-routes sweep billed nothing, so it never reached the model — " +
          "the numbers above would be whatever an all-silent pipeline scores, " +
          "which is a fabricated measurement (PR #38).",
      ).toBeGreaterThan(0);

      if (MIN_PASS !== null) {
        expect(
          sb.totals.runPassRate,
          `run pass rate ${(sb.totals.runPassRate * 100).toFixed(1)}% below the ` +
            `MT_CORPUS_MIN_PASS gate of ${(MIN_PASS * 100).toFixed(1)}%`,
        ).toBeGreaterThanOrEqual(MIN_PASS);
      }
    });
  },
);
