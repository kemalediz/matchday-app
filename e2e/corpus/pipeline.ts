/**
 * The adapter boundary.
 *
 * A "pipeline" is anything that can take a corpus case — the world, the
 * chat history, the messages — and report what happened to the database
 * and what MatchTime said. When this was written there was exactly one
 * implementation, wrapping the mega-prompt analyzer; there are now five,
 * and the SAME cases judge all of them.
 *
 * That is the whole point, so keep this interface free of anything
 * specific to how any one decider works: no verdicts, no intents, no
 * `reasoning`. A pipeline that never produces a verdict must still be
 * able to implement it.
 *
 * §10 step 8 deleted `AnalysisVerdict` altogether, which is this rule
 * paying off rather than a reason to relax it. The boundary carries
 * rows, member names, speech, DMs and reacts, and it did not have to
 * change when the decider it was written around ceased to exist — nor
 * when the cases themselves were ported from verdicts to routes + facts
 * on 2026-09-08. Both times the OBSERVATION was already the right
 * shape.
 */
import type { APIRequestContext } from "@playwright/test";
import type { TestDb } from "../helpers/test-db";
import type { CorpusCase, CorpusObservation } from "./grade";

export type CorpusMode = "stub" | "live";

export interface PipelineContext {
  request: APIRequestContext;
  db: TestDb;
}

export interface CorpusPipeline {
  /** Shown in the scoreboard and the machine-readable report. */
  readonly name: string;
  /** Can this pipeline replay this case in this mode? A stubbed run
   *  needs the case to carry a `route` per message; a live run needs a
   *  key. */
  supports(c: CorpusCase, mode: CorpusMode): boolean;
  /** Replay the case against a FRESH world and report what happened. */
  run(ctx: PipelineContext, c: CorpusCase, mode: CorpusMode): Promise<CorpusObservation>;
}
