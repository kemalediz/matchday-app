/**
 * ═════════════════════════════════════════════════════════════════════
 * THE SHADOW WINDOW-ANALYZER IS RETIRED (§10 step 7/8, 2026-09-06).
 * WHAT IS LEFT OF THIS FILE IS THE `WindowVerdict` PAYLOAD CONTRACT.
 * ═════════════════════════════════════════════════════════════════════
 *
 * From 2026-05-29 this module took the same window the live analyzer saw
 * (fresh batch + history + match context) and asked Claude for ONE
 * coherent state diff for the whole window, then persisted it to the
 * `WindowVerdict` table so `/admin/shadow` could show it side by side
 * with the live per-message verdicts. It never wrote attendance. §8.1
 * measured it at roughly 30% of the whole analyzer bill — a second,
 * entirely uncached `claude-sonnet-4-5` call per batch — and it was
 * switched off by default on 2026-08-31 (PR #28) after three months of
 * paying for a comparison nobody had read.
 *
 * §10 step 7 says "RETIRE THE SHADOW", and step 8 is what makes that
 * unarguable rather than merely thrifty: THE SHADOW WAS A COMPARISON,
 * AND IT COMPARED AGAINST THE MEGA-PROMPT. With `analyzeBatch` and the
 * 19,850-token `SYSTEM_PROMPT` deleted there is nothing on the other
 * side of the diff. Turning it on would spend a Sonnet call per batch to
 * produce a verdict no live path reads and no dashboard can contrast
 * with anything.
 *
 * §7.1 is fair to what it was — "its infrastructure is exactly right and
 * is the migration harness… building it was not wasted work; it was the
 * previous step of this same journey" — and this is the journey
 * arriving.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT WAS DELETED, AND WHY NOTHING IT GUARDED CAN HAPPEN NOW
 * ─────────────────────────────────────────────────────────────────────
 *
 *   • `analyzeWindow` + its private `SYSTEM_PROMPT` — the one-coherent-
 *     diff prompt. Nothing calls it. It read `BatchInputMessage` /
 *     `BatchInputHistory` from `message-analyzer.ts`, both of which were
 *     deleted in step 8; `tsc` was failing on that import.
 *   • `runShadowAnalysis` — the `after()` entry point the analyze route
 *     called on every batch. The route no longer calls it and carries
 *     its own tombstone explaining the retirement.
 *   • `isShadowAnalysisEnabled` / `SHADOW_ANALYZER_ENABLED` — the flag
 *     that kept it from costing anything. A flag guarding a function
 *     that does not exist guards nothing; the spend it prevented is now
 *     prevented by there being no call site. `SHADOW_DAILY_USD_CAP` and
 *     `shadowCapReached` went with it for the same reason — a daily cost
 *     cap on a call nobody makes.
 *   • `computeBatchHash`, `buildShadowMatchContext`, the Sonnet pricing
 *     constants, `extractFirstJsonObject`, `coerceVerdict` — all reached
 *     only from the two entry points above.
 *   • `src/lib/pipeline/shadow.ts` (`runDryRunShadow`, `toWindowShape`,
 *     `shadowPipelineMode` / `SHADOW_PIPELINE`) and its test. That
 *     module existed to REPOINT this harness at the step-2/3 dry run —
 *     "same harness, same table, same dashboard" — and `runShadowAnalysis`
 *     was its only caller. `pipeline/run.ts` does not need it:
 *     `scripts/dryrun-pipeline.ts` and `e2e/corpus/dryrun-pipeline.ts`
 *     call `runPipeline` directly, and `api/cron/none-bucket-shadow`
 *     uses `none-shadow.ts`'s own `toWindowShape`, which is a different
 *     function with the same name.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT IS KEPT, DELIBERATELY, AND WHY THIS FILE STILL EXISTS AT THIS
 * PATH
 * ─────────────────────────────────────────────────────────────────────
 *
 * The `WindowVerdict` TABLE, every historical row in it, and
 * `/admin/shadow` which renders them. Three months of shadow runs are
 * the record of how this decision was reached and are not ours to
 * delete.
 *
 * And the table is NOT dormant. `src/app/api/cron/none-bucket-shadow/`
 * still WRITES new `WindowVerdict` rows for a completely different
 * purpose: §11.1's fourth containment, "shadow the `none` bucket
 * forever… the regression detector the current architecture has never
 * had". That sweep matters MORE after step 8, not less — it is now the
 * only thing that ever looks again at a message the router called
 * banter, because there is no second decider to catch a real IN the
 * router got wrong.
 *
 * So the types below are a LIVE payload contract with two writers and
 * one reader, not an archive. They stay in `src/lib/` rather than moving
 * into `app/admin/shadow/page.tsx` for three reasons:
 *
 *   1. `prisma/schema.prisma` documents `WindowVerdict.verdictJson` by
 *      pointing at THIS PATH ("See `src/lib/window-analyzer.ts` for the
 *      type"). A database column's payload contract does not belong in a
 *      page component, and moving it would either break that comment or
 *      require editing the schema in a deletion PR.
 *   2. `src/lib/pipeline/types.ts`'s `WindowShapedVerdict` is this shape
 *      plus the pipeline's own detail, and `none-shadow.ts` projects
 *      onto it. A shared shape belongs beside its other producer, not
 *      inside one of its consumers.
 *   3. A page is a reader. Two writers and one reader means the contract
 *      goes where all three can import it.
 *
 * If the `none`-bucket sweep is ever retired too, this file goes with
 * it and the types move into whatever still renders the table.
 */

export type WindowStateChangeAction =
  | "drop"
  | "add"
  | "bench"
  | "swap"
  | "score"
  | "no_change";

export interface WindowStateChange {
  action: WindowStateChangeAction;
  /** Human-readable name as it appeared in the chat. */
  targetName: string;
  /** Resolved `User.id` where the producer already knew it. */
  targetUserId?: string;
  /** For "swap" — the other player. */
  swapWithName?: string;
  /** For "score" — the match outcome. */
  scoreRed?: number;
  scoreYellow?: number;
  /** One line on what about the window made this change correct. */
  reason: string;
}

export interface WindowReaction {
  waMessageId: string;
  emoji: string;
  /** Why this ack — usually just "in-confirmation", "ack-out", "ack-info". */
  kind: string;
}

/**
 * The shape stored in `WindowVerdict.verdictJson`.
 *
 * Read by `/admin/shadow`. Written today by
 * `api/cron/none-bucket-shadow` (via `pipeline/none-shadow.ts`), and
 * historically by the retired shadow analyzer. Producers may add fields
 * alongside these — `none-shadow.ts` adds `pipeline` and its own detail
 * — but every producer must fill in all four of these, because the
 * dashboard renders them unconditionally.
 */
export interface WindowVerdict {
  /** One sentence: what happened in this window. */
  windowSummary: string;
  /** Every change the squad should reflect after this window. EMPTY when
   *  the window had no state-relevant content. NOT per-message. */
  stateChanges: WindowStateChange[];
  /** Per-message emoji reactions. */
  reactions: WindowReaction[];
  /** One group reply for the whole window, or null when none is
   *  warranted. */
  groupReply: string | null;
}
