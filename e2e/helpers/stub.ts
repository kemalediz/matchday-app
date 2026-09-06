/**
 * The three stub seams the e2e suite drives the server through, in the
 * order a request meets them: the VERDICT seam (dead), the ROUTER seam,
 * the EXTRACTOR seam.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ⚠️ THE VERDICT SEAM IS INERT SINCE §10 STEP 8 — READ THIS FIRST
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `setLlmStub` used to write the file `analyzeBatch` read instead of
 * calling Anthropic: a map of waMessageId → the verdict the model "would
 * have emitted". §10 step 8 deleted `analyzeBatch`, `SYSTEM_PROMPT` and
 * `AnalysisVerdict` from `src/lib/message-analyzer.ts` and
 * `executeVerdict` from `analyze/route.ts`. **Nothing reads the contents
 * of that file any more.** `setLlmStub({...})` still writes it; the
 * server never opens it.
 *
 * WHY THE FUNCTION IS STILL HERE, rather than deleted with the decider
 * it stubbed: `MT_TEST_LLM_STUB_FILE` is ALSO the DM-Q&A stub flag.
 * `src/lib/dm-qa.ts:180` reads `!!process.env.MT_TEST_LLM_STUB_FILE` as a
 * plain truthiness test and, when set, returns the SCOPED CONTEXT itself
 * instead of calling Anthropic — which is how `e2e/sim/qa.spec.ts`
 * asserts the no-leak guarantee structurally (no raw phone digits ever
 * enter a model's context). That flag is live. The env var stays, the
 * path stays, and only the FILE'S CONTENTS are dead.
 *
 * WHAT REPLACED IT, and why it is not the same shape: `MT_TEST_ROUTER_STUB_FILE`
 * (`src/lib/pipeline/gate.ts`) and `MT_TEST_EXTRACTOR_STUB_FILE`
 * (`src/lib/pipeline/extractor-stub.ts`), both below. They stub FACTS and
 * ROUTES, never a decision — the model is no longer asked for one, so a
 * stub that could express one would be stubbing something that does not
 * exist. `StubVerdict.registerAttendance` has no successor field
 * anywhere: what used to be "the model said register this person IN" is
 * now a `claim` with a `polarity`, which the ENGINE then decides about.
 *
 * ── WHAT THIS COSTS TODAY, MEASURED RATHER THAN ESTIMATED ────────────
 *
 * `npx tsx e2e/run.ts` on 2026-09-06, after §10 step 8:
 *
 *     40 failed · 150 passed · 80 skipped · 82 did not run   (1.5m)
 *
 * Every one of the 40 is a spec addressing the server through `verdict:`
 * or `setLlmStub`. They do not fail to COMPILE — a `StubVerdict` is
 * still a valid object — they fail to MEAN anything: the server gets no
 * route it was told about, no facts, and (per `route.ts`'s "NOBODY OWNED
 * IT" branch) stays silent, so every assertion that something was
 * written fails. The 82 that "did not run" are the rest of the serial
 * files those failures aborted, so the real number is larger.
 *
 * The files still on the dead seam:
 *
 *   e2e/api/analyze-honest-ack.spec.ts      e2e/sim/recruit.spec.ts
 *   e2e/api/analyzer.spec.ts                e2e/sim/router-gate.spec.ts
 *   e2e/api/attendance-event-log.spec.ts    e2e/sim/router-gate-awaiting.spec.ts
 *   e2e/api/pasted-roster.spec.ts           e2e/sim/score-mom.spec.ts
 *   e2e/corpus/current-analyzer-pipeline.ts e2e/sim/show-teams.spec.ts
 *   e2e/sim/attendance.spec.ts              e2e/sim/squad-from-list.spec.ts
 *   e2e/sim/attendance-engine-overload.spec.ts
 *   e2e/sim/bench-capacity.spec.ts          e2e/sim/squad-post.spec.ts
 *   e2e/sim/guest-name-ask.spec.ts          e2e/sim/teams.spec.ts
 *   e2e/sim/interaction-contract.spec.ts    e2e/sim/tentative-followup.spec.ts
 *   e2e/sim/qa.spec.ts                      e2e/sim/third-party-offer.spec.ts
 *   e2e/sim/self-replace-live.spec.ts
 *
 * They are LEFT FAILING on purpose rather than deleted or weakened. Each
 * one pins a shipped behaviour that still exists — capacity, bench
 * offers, the interaction contract, the batch-final squad post — and the
 * port is mechanical but not small: every `verdict:` becomes a
 * `setRouterStub({ bodies })` entry plus a `setExtractorStub({ bodies })`
 * entry. There is no longer a flag to turn on for the attendance path
 * (`ROUTER_GATE_ENABLED` and `ATTENDANCE_ENGINE_ENABLED` were deleted in
 * the same change) and step 7's four routes default ON, so a port is
 * usually just the two `bodies` maps; `engineRoutes` below is for the
 * cases that need a step-7 route explicitly on or off. Deleting them to make the
 * suite green would delete the only end-to-end coverage of the apply
 * path; a half-done port that passes would be worse still. The list is
 * here so the size of the remaining job is a fact rather than a
 * discovery.
 *
 * `e2e/sim/attendance-engine.spec.ts` is the worked example of what a
 * ported spec looks like — 25/25 green against the pipeline's seams,
 * including four cases whose MEANING changed rather than their
 * mechanism, each documented at its own site.
 *
 * TWO OF THE FORTY NEED AN INVERSION, NOT A PORT, and they are the ones
 * to read first because the behaviour they assert is genuinely gone:
 *
 *   • `e2e/sim/attendance-engine-overload.spec.ts` — "TOTAL overload:
 *     every extraction fails and the analyzer takes the whole batch".
 *     There is no analyzer. Every message is now LOST, loudly. The same
 *     inversion is already written out in
 *     `attendance-engine.spec.ts`'s "an extractor failure now LOSES the
 *     write, and says so".
 *   • `e2e/sim/router-gate.spec.ts` — "with the gate OFF, the batch
 *     reaches the analyzer exactly as it does today". `ROUTER_GATE_ENABLED`
 *     was deleted along with the analyzer it reverted to; there is no
 *     gate-off state to test. `src/lib/pipeline/__tests__/gate.test.ts`
 *     holds the tombstone.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { E2E } from "./env";

/**
 * ⚠️ DEAD SHAPE. This is `AnalysisVerdict`'s test-side mirror and
 * `AnalysisVerdict` no longer exists. Kept only so the twenty-one specs
 * listed in the header still compile while they wait to be ported; do
 * not add a field to it, and do not write a new spec against it.
 */
export interface StubVerdict {
  intent?: string;
  confidence?: number;
  react?: string | null;
  reply?: string | null;
  registerAttendance?: "IN" | "OUT" | "BENCH" | null;
  benchConfirmation?: "yes" | "no" | null;
  registerFor?: Array<{ name: string; action: "IN" | "OUT" | "BENCH" }> | null;
  /** The message asks for MORE PLAYERS. A flag, not an intent — it
   *  coexists with the attendance the same message carries. */
  recruitRequest?: boolean;
  scoreRed?: number | null;
  scoreYellow?: number | null;
  includeNames?: string[] | null;
  teamOverrides?: Array<{ name: string; team: "RED" | "YELLOW" }> | null;
  teamNames?: [string, string] | null;
  bulkPayment?: { payerName: string; count: number; coveredNames?: string[] } | null;
  reminder?: { date: string; time?: string; note: string } | null;
  reasoning?: string;
}

/**
 * ⚠️ NO LONGER CHANGES WHAT THE SERVER DECIDES. See the header: the file
 * it writes has had no reader since §10 step 8 deleted `analyzeBatch`.
 * It still writes it, because `E2E.LLM_STUB_FILE` is the path
 * `MT_TEST_LLM_STUB_FILE` points at and `dm-qa.ts` keys its own stub off
 * that variable being set.
 */
export function setLlmStub(verdicts: Record<string, StubVerdict>): void {
  mkdirSync(path.dirname(E2E.LLM_STUB_FILE), { recursive: true });
  writeFileSync(E2E.LLM_STUB_FILE, JSON.stringify({ verdicts }, null, 2));
}

export function clearLlmStub(): void {
  setLlmStub({});
}

/**
 * The ROUTER stub (§10 step 5). Same seam, one layer earlier: it says
 * what the router answered and whether the gate and the floor are on for
 * this request.
 *
 * `{}` means "no override" — the flags fall back to the environment,
 * where both are OFF. That is what `clearRouterStub()` writes, and why
 * every spec that has never heard of the router is unaffected by the
 * file's existence.
 */
export interface RouterStub {
  /**
   * ⚠️ INERT since §10 step 8 (2026-09-06). `enabled` overrode
   * `ROUTER_GATE_ENABLED` and `engine` overrode
   * `ATTENDANCE_ENGINE_ENABLED`; BOTH FLAGS ARE DELETED from
   * `pipeline/gate.ts`, and `RouterStubConfig` there no longer declares
   * either field. A stub file carrying them parses and selects nothing.
   *
   * KEPT so the ~20 specs that pass them still compile, and because the
   * fields are harmless: the reader ignores unknown keys by
   * construction. `gate.ts`'s essay is the place to read WHY the flags
   * went — in short, their "off" position reverted to `analyzeBatch`,
   * and `ATTENDANCE_ENGINE_ENABLED=0` would now mean NOBODY handles
   * `self_att` / `other_att` / `offer` / `unsure`. Do not write a new
   * spec that sets either: it will read as configuration and be none.
   */
  enabled?: boolean;
  /** See `enabled` — INERT since §10 step 8. */
  engine?: boolean;
  /** Overrides ROUTER_GATE_FLOOR_ENABLED. The only boolean on this stub
   *  that still selects anything. */
  floor?: boolean;
  /**
   * Which of §10 step 7's routes this request owns — `question`,
   * `balancer`, `score`, `admin_ops`. Read by
   * `src/lib/pipeline/route-flags.ts:routeStubConfig` out of THIS SAME
   * FILE, deliberately: one stub JSON configures the whole pipeline for
   * a request, rather than two files that can disagree about which
   * request they describe.
   *
   * It was reachable from the server and NOT from this helper until §10
   * step 8, which is why no spec drove a step-7 route deterministically.
   * Before step 8 that only meant the mega-prompt answered instead; now
   * it means silence, so the seam has to be expressible here.
   *
   * Omitted → the env flags, WHICH NOW DEFAULT ON (step 8 inverted the
   * four: `enabledStepSevenRoutes` starts from every step-7 route and
   * removes the ones a flag switches OFF). `[]` → own nothing, stated
   * rather than defaulted, which is the only way a spec can now assert
   * "and this route was not owned".
   */
  engineRoutes?: string[];
  /**
   * waMessageId → route. Unmapped ids fall back to `unsure`
   * (`gate.ts:711`), and WHAT THAT MEANS CHANGED WITH §10 STEP 8: this
   * comment used to read "so the analyzer still sees them — the
   * direction that cannot lose a write". There is no analyzer. `unsure`
   * joined `ENGINE_ROUTES` (`gate.ts:265-270`) in the same change and
   * for that reason, so an unmapped id now goes to the ATTENDANCE
   * EXTRACTOR when the engine flag is on, and to nobody when it is not.
   * Either way a spec that leaves an id unmapped is asserting something
   * about the engine, not about a fallback.
   */
  routes?: Record<string, string>;
  /** Trimmed body → route. The sim harness mints its own message ids, so
   *  a spec addresses the router by what was said. */
  bodies?: Record<string, string>;
}

export function setRouterStub(stub: RouterStub): void {
  mkdirSync(path.dirname(E2E.ROUTER_STUB_FILE), { recursive: true });
  writeFileSync(E2E.ROUTER_STUB_FILE, JSON.stringify(stub, null, 2));
}

export function clearRouterStub(): void {
  setRouterStub({});
}

/**
 * The EXTRACTOR stub (§10 step 6). One layer later than the router: it
 * says what FACTS the attendance extractor returned for a given body.
 *
 * It deliberately carries the model's RAW JSON rather than a `Facts`
 * object, so `parseFacts` still runs for real — the enum re-validation,
 * the dropped claim on a drifted polarity and the "none" → null
 * affirmation mapping are part of what a step-6 spec is testing.
 *
 * `{}` — what `clearExtractorStub()` writes — means every body extracts
 * NO claims. That is the direction that cannot invent a write in a spec
 * which has never heard of the engine, and combined with the flag
 * defaulting off it is why the existing suite is untouched by this
 * file's existence.
 */
export interface ExtractorStub {
  bodies?: Record<string, Record<string, unknown>>;
  /** Bodies whose extractor CALL fails with a real overload error, after
   *  the SDK's four retries. The only way to exercise the fail-open
   *  fallback end to end. */
  fail?: string[];
  /** Every extractor call fails — the total-overload edge. */
  failAll?: boolean;
}

/** A single attendance claim, with the boring fields filled in. */
export function claim(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subject: "sender",
    personRef: "",
    personNamed: false,
    polarity: "in",
    contingent: false,
    conditionOn: "none",
    tense: "present",
    basis: "decision",
    reported: false,
    confidence: 0.95,
    ...over,
  };
}

/** The whole attendance-extractor body, with the boring fields filled in. */
export function facts(
  claims: Array<Record<string, unknown>>,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return { claims, affirmation: "none", sideRequests: [], ...over };
}

export function setExtractorStub(stub: ExtractorStub): void {
  mkdirSync(path.dirname(E2E.EXTRACTOR_STUB_FILE), { recursive: true });
  writeFileSync(E2E.EXTRACTOR_STUB_FILE, JSON.stringify(stub, null, 2));
}

export function clearExtractorStub(): void {
  setExtractorStub({});
}
