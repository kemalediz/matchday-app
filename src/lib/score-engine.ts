/**
 * §10 STEP 7 PART 2 — THE SCORE APPLY LAYER.
 *
 *   router → score extractor → engine → APPLY → composer
 *
 * `src/lib/pipeline/` decides and composes and is forbidden from
 * writing — `pipeline/__tests__/zero-writes.test.ts` scans every file in
 * that directory on every build. This module is the other side of that
 * line, and it lives OUTSIDE `pipeline/` for exactly that reason, in the
 * same place and for the same reason `attendance-engine.ts` does.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT IT WRITES, AND WHY IT IS TWO WRITES AND NOT ONE
 * ─────────────────────────────────────────────────────────────────────
 * The shipped path (`route.ts:3508-3533`) does two things, in order,
 * with the second wrapped in its own `try`:
 *
 *   1. `Match.redScore` / `yellowScore` / `status = COMPLETED`.
 *   2. the Elo deltas across every `TeamAssignment` on that match.
 *
 * The nesting is deliberate and is reproduced here rather than tidied
 * into one transaction. A score is a FACT the group reported; the Elo
 * update is a DERIVED consequence of it. If the derivation fails — no
 * team assignments, a rating row that moved — the right outcome is a
 * recorded score and a logged error, not a rolled-back score and a group
 * that thinks MatchTime ignored them. Losing the score is the failure
 * mode `route.ts:3462` calls the worse one, and it is the failure mode
 * a single transaction would introduce.
 *
 * ─────────────────────────────────────────────────────────────────────
 * IT DECIDES NOTHING
 * ─────────────────────────────────────────────────────────────────────
 * Which match, which numbers, whether the sender may report a result,
 * whether a recorded score may be overwritten: all of that is
 * `engine.ts`'s `handleScore`, and none of it is re-litigated here.
 * Every branch below is a mechanical translation of a field the engine
 * already set. `computeEloDeltas` is imported from `elo.ts` — pure, and
 * already the only implementation of that arithmetic in the codebase.
 *
 * It imports neither `db` nor Prisma; its dependencies are injected,
 * which is what makes the seam unit-testable without a database, and a
 * test asserts the absence by SCANNING this file, because a comment
 * saying so is worth nothing (four seatbelts were found dead on
 * 2026-08-31, all with comments claiming they worked).
 */
import { computeEloDeltas, type EloDelta, type PlayerEloInput } from "./elo";
import type { ProposedWrite } from "./pipeline/types";

export type EngineScoreWrite = Extract<ProposedWrite, { kind: "score" }>;

/**
 * Prefix on every degradation this layer reports, so the analyze route's
 * partial-response admin DM can match a TYPED marker instead of
 * prefix-matching free-text reasoning. Mirrors
 * `ENGINE_APPLY_DEGRADED_PREFIX` for step 6.
 */
export const SCORE_APPLY_DEGRADED_PREFIX = "score-engine: degraded —";

/** `AnalyzedMessage.handledBy` for a message this path decided. The
 *  AUDIT field, not the wire field — the same split step 5 made for
 *  `router-gate` and step 6 for `attendance-engine`. */
export const SCORE_HANDLED_BY = "score-engine";

export interface ScoreApplyDeps {
  /** `Match.redScore` / `yellowScore` / `status = COMPLETED`, in one
   *  update. The ONE way a score is written on this path. */
  recordScore: (args: { matchId: string; red: number; yellow: number }) => Promise<void>;
  /** Every `TeamAssignment` on the match, with the player's current
   *  `matchRating`. Empty is a legitimate answer — a match whose teams
   *  were never generated has no Elo to compute. */
  loadEloInputs: (matchId: string) => Promise<PlayerEloInput[]>;
  /** Persist the computed deltas. One transaction, as
   *  `route.ts:3526-3530` does it. */
  applyEloDeltas: (deltas: EloDelta[]) => Promise<void>;
}

export interface ScoreWriteResult {
  write: EngineScoreWrite;
  /** Did the SCORE land? The Elo pass can fail on its own without
   *  making this false — see the header. */
  ok: boolean;
  error?: string;
  /** How many player ratings moved. 0 when the match had no teams. */
  eloApplied: number;
  /** Set when the score landed and the Elo pass did not. Surfaced, never
   *  swallowed: a silent Elo failure is a leaderboard that quietly stops
   *  moving, which nobody notices for a month. */
  eloError?: string;
}

/**
 * Apply the engine's score writes.
 *
 * Sequential rather than `Promise.all`, and that is not caution: two
 * score writes in one batch would be two messages about the SAME match
 * (the engine only ever proposes one per match, because it refuses to
 * overwrite a result once its projection has recorded one), and racing
 * two updates to one row for no gain is how the second one wins by
 * accident.
 */
export async function applyScoreWrites(args: {
  writes: EngineScoreWrite[];
  deps: ScoreApplyDeps;
}): Promise<ScoreWriteResult[]> {
  const { writes, deps } = args;
  const results: ScoreWriteResult[] = [];

  for (const write of writes) {
    try {
      await deps.recordScore({ matchId: write.matchId, red: write.red, yellow: write.yellow });
    } catch (err) {
      // The score itself failed. Nothing derived from it should run, and
      // the caller must not compose "recorded" over a write that threw —
      // that is §3.2 S7's "WORDS MUST MATCH ACTION", the 2026-05-15
      // Erdal incident, in a different corner of the system.
      results.push({
        write,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        eloApplied: 0,
      });
      continue;
    }

    // ── The derived half. Its failure never unmakes the score. ───────
    let eloApplied = 0;
    let eloError: string | undefined;
    try {
      const inputs = await deps.loadEloInputs(write.matchId);
      const deltas = computeEloDeltas(inputs, write.red, write.yellow);
      if (deltas.length > 0) {
        await deps.applyEloDeltas(deltas);
        eloApplied = deltas.length;
      }
    } catch (err) {
      eloError = err instanceof Error ? err.message : String(err);
      console.error("[score-engine] Elo update after a recorded score failed:", err);
    }

    results.push({ write, ok: true, eloApplied, ...(eloError ? { eloError } : {}) });
  }

  return results;
}
