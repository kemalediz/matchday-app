/**
 * Pipeline #3 — the SHIPPED route with §10 step 6's attendance engine
 * turned ON, so it really writes.
 *
 * This is the difference from `DryRunPipeline` (#2) and it is the whole
 * point of step 6. #2 grades the DECISION: it reads the world, decides
 * what it would do, and projects that forward in memory. #3 grades the
 * WRITE: the same router, the same extractor, the same engine, and then
 * `registerAttendance` / `cancelAttendance` with their transactions,
 * their position ordering, their `AttendanceEvent`s, their bench-offer
 * bookkeeping, the recruit blast, and the batch-final squad-post
 * composition. `attendanceAfter` here is a database read, not a
 * proposal.
 *
 * That is what makes corpus case `PR33-recruit-ask-must-not-swallow-the-drop`
 * scoreable at all. It expects `DM'd N recent players`, and a dry run
 * performs no DM blast, so #2 scores it 0/3 by construction. #3 must
 * pass it, and `e2e/corpus/README.md`'s rule 5 applies: check the code
 * path before calling a failure a defect.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS PIPELINE IS NOW IDENTICAL TO #1 (§10 step 8, 2026-09-06)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * What stood here, and it was the whole design of this class:
 *
 *   "A LIVE sweep runs one dev server whose environment is fixed at
 *    boot… So an A/B — the same real model, the same real world, the
 *    engine on for one arm and off for the other, in ONE process —
 *    needs a per-REQUEST signal. That is the `x-mt-attendance-engine`
 *    header… The baseline arm is the plain `CurrentAnalyzerPipeline`,
 *    which sends no header at all and therefore gets the server's own
 *    flag — off."
 *
 * `ATTENDANCE_ENGINE_ENABLED` and its header (`ENGINE_HEADER` /
 * `engineHeaderOverride`) were DELETED from `src/lib/pipeline/gate.ts`
 * in step 8, in that file's words because "there is no second arm to A/B
 * against any more": the flag's off position reverted to `analyzeBatch`,
 * and `analyzeBatch` is gone. So both arms of this A/B are now the same
 * arm. The `attendanceEngine` field that sent the header is deleted with
 * the header itself; pipeline #1 already runs the engine, because that is
 * simply how the route works.
 *
 * KEPT RATHER THAN DELETED, for one reason: `pipeline` is a NAME in
 * `baseline.stub.json` and in every report under `.e2e/corpus/`, and a
 * sweep quoted as "attendance-engine: 34/36" must stay re-runnable and
 * must keep meaning what it meant. It no longer measures a DIFFERENCE
 * from #1 — do not quote the two side by side as an A/B, because since
 * 2026-09-06 that comparison has no independent variable.
 */
import { CurrentAnalyzerPipeline } from "./current-analyzer-pipeline";
import type { CorpusCase } from "./grade";
import type { CorpusMode } from "./pipeline";

export class AttendanceEnginePipeline extends CurrentAnalyzerPipeline {
  override readonly name = "attendance-engine";

  /**
   * LIVE ONLY, deliberately.
   *
   * This said "a stubbed corpus run drives each case's `stub` block,
   * which is a VERDICT — and the engine never wanted one". That was the
   * argument until 2026-09-08, when the corpus was ported: a stub is now
   * a ROUTE and some FACTS, which is exactly what the engine does want,
   * and `CurrentAnalyzerPipeline` (which this extends) runs the whole
   * stubbed sweep through it.
   *
   * LIVE-ONLY IS KEPT ANYWAY, for the reason in the header above: since
   * §10 step 8 this class is byte-for-byte the same pipeline as #1, so a
   * stubbed run of it would score the same 35 cases twice and read like
   * a second measurement. The name survives so quoted live sweeps stay
   * re-runnable; it has nothing left to add in stubbed mode.
   */
  override supports(_c: CorpusCase, mode: CorpusMode): boolean {
    return mode === "live";
  }
}

export default AttendanceEnginePipeline;
