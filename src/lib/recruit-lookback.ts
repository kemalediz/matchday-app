/**
 * The recruit blast's lookback window, and its ceiling — SPLIT OUT of
 * `recruit.ts` so the decision engine can reach it.
 *
 * `recruit.ts` imports `db`. The pipeline must not: `answer-batch.ts`'s
 * "ONE IMPORT RULE" records what happens when it does — the Playwright
 * corpus worker never loads Prisma (`e2e/sim/group.ts` talks plain SQL),
 * so a static import that reaches the generated client kills the whole
 * spec file at load with "exports is not defined in ES module scope",
 * before a single model call, and the sweep reports "no tests found"
 * rather than a failure anyone can read.
 *
 * These two values and one clamp are pure. `recruit.ts` re-exports them
 * so its callers are unchanged and there is exactly one ceiling in the
 * codebase.
 */

/**
 * How many recent COMPLETED matches to pull candidates from.
 *
 * Widened 3 → 5 at the owner's request (2026-08-31). Measured pool sizes
 * for that club (12 completed matches, 73 active members):
 *   lookback 3 → 17 players, 5 → 22, 10 → 35, 12 → 39.
 * At 3, after excluding everyone already registered, only 9 invites went
 * out and the squad stayed short.
 *
 * DO NOT raise this default further.
 */
export const LOOKBACK_MATCHES = 5;

/**
 * Hard ceiling on any per-invocation override. Ban-risk backstop.
 *
 * The bot runs on an UNOFFICIAL WhatsApp client; a mass DM risks the
 * account being banned, which takes the whole product down. That is why
 * a number a language model read out of a sentence — "message everyone
 * from the last 50 games" — is clamped here rather than trusted.
 */
export const RECRUIT_LOOKBACK_MAX = 12;

/**
 * Sanitise a caller-supplied lookback: floor it, clamp it to
 * [1, RECRUIT_LOOKBACK_MAX], and fall back to the default when it is
 * missing or not a finite number.
 */
export function resolveLookbackMatches(requested?: number | null): number {
  if (requested === undefined || requested === null || !Number.isFinite(requested)) {
    return LOOKBACK_MATCHES;
  }
  return Math.min(RECRUIT_LOOKBACK_MAX, Math.max(1, Math.floor(requested)));
}
