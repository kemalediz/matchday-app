/**
 * §10 STEP 7 PART 2 — THE `admin_ops` ROUTE, END TO END.
 *
 *   router → admin extractor → engine → APPLY → composer
 *
 * The last route on the mega-prompt, and the one part 1 was most careful
 * about. `answer-batch.ts`'s header states why it was held back:
 *
 *   *"`admin_ops` is real money on a live club (S21 — `PaymentCredit`,
 *    `Attendance.paidAt`) plus a reminder whose time phrase still has to
 *    become a datetime. The engine models the phrase exactly as §3.2 S22
 *    asks and hands it on; nothing resolves it yet, and `date-fns-tz`
 *    doing that resolution is new code on a path that queues a DM. It
 *    also has four guards the engine does not carry — the `reminders`
 *    feature gate, the `subReminderDm` opt-out, the missing-phone branch
 *    and the 60-day window (`route.ts:3925-3995`)."*
 *
 * All four guards are accounted for, and two of them are answered by
 * OWNING LESS rather than by re-implementing a sentence:
 *
 *   | guard                | where it lives now                        |
 *   |----------------------|-------------------------------------------|
 *   | `reminders` feature  | `engine.ts` — `state.features.reminders`  |
 *   | 60-day window        | `engine.ts` — the shipped grace and bound |
 *   | `subReminderDm`      | HERE, as a carve-out: a muted player's    |
 *   |                      | message is handed back so the analyzer    |
 *   |                      | sends the shipped 🔕 sentence             |
 *   | missing phone        | `engine.ts` degrades → handed back, so    |
 *   |                      | the analyzer sends the shipped 🤔 line    |
 *
 * The last two are deliberate. Both shipped branches answer the player
 * with a specific sentence and a specific react, and inventing a second
 * wording for a shipped sentence is how two bots start disagreeing with
 * each other in the same group. Handing the message back costs one
 * analyzer call and gives the player the exact words they get today.
 *
 * ─────────────────────────────────────────────────────────────────────
 * FAIL OPEN, ALWAYS
 * ─────────────────────────────────────────────────────────────────────
 *   • `ADMIN_OPS_ENGINE_ENABLED` is off      → owns nothing
 *   • step 5's gate skipped it               → owns nothing
 *   • the router never mentioned the id      → owns nothing
 *   • the state load threw                   → owns nothing
 *   • the opt-out lookup threw               → owns nothing
 *   • the extractor call threw               → THAT message handed back
 *   • the facts are not admin facts          → handed back
 *   • admin action `other`                   → handed back (the
 *                                              mega-prompt still has
 *                                              intents this route does
 *                                              not model)
 *   • payment tracking is off for the org    → handed back
 *   • no genuinely COMPLETED, non-historical
 *     match to credit against                → handed back
 *   • the sender muted reminder DMs          → handed back
 *   • the engine threw                       → owns nothing
 *   • the engine proposed a write this path
 *     cannot apply                           → owns nothing, loudly
 *   • an apply threw                         → owned, but SILENT, and
 *                                              the failure is reported
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY THE TAG IS NOT A PRE-FILTER HERE
 * ─────────────────────────────────────────────────────────────────────
 * `answer-batch.ts` refuses an untagged message before the extractor
 * runs, which is free and strictly conservative for its two routes. This
 * one cannot: two of `admin_ops`'s three actions require a tag and the
 * third does NOT — PR #33's `RECRUIT_COMMAND_IMPLIES_ADDRESSED` makes an
 * admin's recruit command a direct instruction to MatchTime on its own,
 * and that is the 2026-09-01 incident's actual fix. Which action a
 * message carries is only knowable AFTER extraction, so the tag is
 * enforced per action, in the engine, exactly where the contract's own
 * `ACTIONY_INTENTS` split lives. The cost is one extractor call on an
 * untagged `admin_ops` message.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE RECRUIT BLAST IS DECIDED HERE AND RUN LATER
 * ─────────────────────────────────────────────────────────────────────
 * `recruitRequest` on the outcome is the same field
 * `attendance-engine-batch.ts` already reports, read by the same
 * batch-final pass at `route.ts:2436`, which fires the blast AFTER every
 * write in the batch has landed. That ordering IS the fix for
 * 2026-09-01, where a regex ran the blast first, against a 10/10 squad,
 * and MatchTime told the owner his squad was full one line after he said
 * Najib was out. Applying `recruit_blast` here would rebuild that bug.
 */
import {
  ADMIN_OPS_APPLY_DEGRADED_PREFIX,
  ADMIN_OPS_HANDLED_BY,
  applyPaymentCredit,
  applyReminder,
  composePaymentAck,
  type AdminOpsApplyDeps,
  type EnginePaymentWrite,
  type EngineReminderWrite,
} from "./admin-ops-engine";
import { compose } from "./pipeline/compose";
import { decide as decideDefault } from "./pipeline/engine";
import { extractForRoute } from "./pipeline/extractors";
import { extractorStubFromEnv } from "./pipeline/extractor-stub";
import { anthropicModel, type PipelineModel } from "./pipeline/llm";
import { ADMIN_OPS_ENGINE_ROUTES, stepSevenOwnsRoute } from "./pipeline/route-flags";
import type {
  AdminFacts,
  EngineInput,
  EngineMessage,
  EngineResult,
  Facts,
  Route,
  SquadState,
} from "./pipeline/types";

export { ADMIN_OPS_APPLY_DEGRADED_PREFIX, ADMIN_OPS_HANDLED_BY };

/** The routes this module can own. From `route-flags.ts`, so the flag
 *  and the owner cannot disagree about the list. */
export const ADMIN_OPS_ROUTES = ADMIN_OPS_ENGINE_ROUTES;

export interface AdminOpsBatchMessage {
  waMessageId: string;
  body: string;
  authorName: string | null;
  senderUserId: string | null;
  senderName: string | null;
  tagged: boolean;
  /** From the router. `undefined` when it never mentioned this id. */
  route: Route | undefined;
  /** Did step 5's gate skip this message? Then this never sees it. */
  gated: boolean;
}

export interface AdminOpsMessageOutcome {
  waMessageId: string;
  route: Route;
  reply: string | null;
  react: string | null;
  /** `AnalyzedMessage.intent`, in the vocabulary the admin log speaks —
   *  and derived from what HAPPENED, never from a model. */
  intent: string;
  /** `AnalyzedMessage.action`. */
  action: string;
  /** Machine reasons, one per rule that fired. Never prose for a regex
   *  to parse — nothing in this codebase parses it. */
  reasoning: string;
  /**
   * An admin asked for a recruit blast in this message. The SAME field
   * `attendance-engine-batch.ts` reports, for the same batch-final pass
   * at `route.ts:2436`. The blast must run after the batch's writes.
   */
  recruitRequest: boolean;
  /** The clamped lookback for that blast, or null for the default of 5.
   *  `inviteRecentPlayers` takes it as its second argument. */
  recruitLookbackMatches: number | null;
  /** A write threw. The caller must not say anything cheerful. */
  writeFailed: boolean;
}

export interface AdminOpsBatchResult {
  ownedIds: Set<string>;
  outcomes: Map<string, AdminOpsMessageOutcome>;
  degradations: string[];
  cost: { usd: number; calls: number; ms: number };
}

export interface AdminOpsBatchDeps extends AdminOpsApplyDeps {
  /** Members who have turned reminder DMs off (`Membership.subReminderDm
   *  = false`). See the carve-out table in the header. */
  reminderMutedUserIds: () => Promise<string[]>;
  /** Injected so tests can drive the whole batch without a key. */
  model?: PipelineModel;
  /** Injected so tests can load a state without a database. */
  loadState?: (orgId: string, now: Date) => Promise<SquadState>;
  /** Injected so a test can prove the write assertion and the
   *  throw-safety without a fabricated rule in the real engine. */
  decide?: (input: EngineInput) => EngineResult;
}

function empty(degradations: string[] = []): AdminOpsBatchResult {
  return {
    ownedIds: new Set(),
    outcomes: new Map(),
    degradations,
    cost: { usd: 0, calls: 0, ms: 0 },
  };
}

export async function runAdminOpsBatch(args: {
  orgId: string;
  now: Date;
  messages: AdminOpsBatchMessage[];
  history: Array<{ author: string | null; body: string }>;
  enabled: Set<Route>;
  deps: AdminOpsBatchDeps;
}): Promise<AdminOpsBatchResult> {
  const { orgId, now, messages, history, enabled, deps } = args;
  const t0 = Date.now();

  // ── Ownership, part 1: everything knowable without a model ─────────
  const candidates = messages.filter(
    (m) => !m.gated && stepSevenOwnsRoute(m.route, enabled, ADMIN_OPS_ROUTES),
  );
  if (candidates.length === 0) return empty();

  const degradations: string[] = [];

  let state: SquadState;
  try {
    state = deps.loadState
      ? await deps.loadState(orgId, now)
      : await (await import("./pipeline/load-state")).loadSquadState(orgId, now);
  } catch (err) {
    const detail = `${ADMIN_OPS_APPLY_DEGRADED_PREFIX} state load failed (${
      err instanceof Error ? err.message : String(err)
    }); the analyzer keeps the batch`;
    console.error("[admin-ops-engine] state load failed:", err);
    return empty([detail]);
  }

  let muted: Set<string>;
  try {
    muted = new Set(await deps.reminderMutedUserIds());
  } catch (err) {
    // The opt-out is a promise MatchTime made to a player who asked it
    // to stop messaging them. A lookup that failed is not permission to
    // DM them anyway — own nothing and let the analyzer, which does its
    // own lookup, decide.
    const detail = `${ADMIN_OPS_APPLY_DEGRADED_PREFIX} the reminder opt-out lookup failed (${
      err instanceof Error ? err.message : String(err)
    }); the analyzer keeps the batch`;
    console.error("[admin-ops-engine] opt-out lookup failed:", err);
    return empty([detail]);
  }

  // ── Stage 2: extractors, in parallel ───────────────────────────────
  const model = deps.model ?? extractorStubFromEnv() ?? anthropicModel();
  const lastBotPost =
    [...history].reverse().find((h) => (h.author ?? "").toLowerCase() === "matchtime")?.body ??
    state.lastBotPost ??
    null;
  state = { ...state, lastBotPost };

  let cost = { usd: 0, calls: 0, ms: 0 };
  const factsById = new Map<string, Facts>();
  await Promise.all(
    candidates.map(async (m) => {
      const res = await extractForRoute(model, m.route as Route, {
        id: m.waMessageId,
        body: m.body,
        authorName: m.authorName,
        tagged: m.tagged,
        history,
        lastBotPost,
      });
      for (const d of res.degradations) {
        degradations.push(`extractor ${m.waMessageId}: ${d.detail}`);
      }
      if (res.usage) {
        cost = {
          usd: cost.usd + (res.usage.costUsd ?? 0),
          calls: cost.calls + 1,
          ms: Math.max(cost.ms, res.usage.ms),
        };
      }
      const failure = res.degradations.find((d) => /failed|could not be parsed/i.test(d.detail));
      if (failure) {
        degradations.push(
          `${ADMIN_OPS_APPLY_DEGRADED_PREFIX} ${m.waMessageId}: ${failure.detail} — ` +
            `handing this message back to the analyzer`,
        );
        return;
      }
      factsById.set(m.waMessageId, res.facts);
    }),
  );

  // ── The payment target, decided once, before anything is owned ─────
  //
  // EXACTLY the shipped selector (`route.ts:3801-3803`): the most recent
  // genuinely COMPLETED, non-historical match. `SquadState.completedMatch`
  // is now WIDER than that — it also holds a match that has been played
  // but never scored — because the `score` route needs it to be. Money
  // does not: crediting a payment against a match nobody has recorded a
  // result for, or against a seeded backfill row, is not a shape this
  // owns. When the two disagree, the analyzer keeps the message and its
  // own query picks the older COMPLETED match, exactly as today.
  const completed = state.completedMatch;
  const paymentMatchId =
    completed && completed.status === "COMPLETED" && !completed.isHistorical
      ? completed.id
      : null;

  // ── Ownership, part 2: shapes only visible after extraction ────────
  //
  // ON THE `continue`s. Three defects in one week came from a terminal
  // `continue` silently skipping every guard below it, so, explicitly:
  // the ONLY effect of a full pass through this loop body is
  // `ownedIds.add(...)`. There is no write, no send, no state mutation
  // and no later guard inside it, so a `continue` can skip exactly one
  // thing — ownership — which is the intent. Everything a skipped
  // message still needs happens OUTSIDE the loop: it reaches `decide()`
  // with `facts: {kind:"none"}` (so `assertCoverage` still sees one
  // outcome per input id and the window is intact for its neighbours),
  // it gets no entry in `outcomes` (so the analyze route leaves its
  // verdict alone and the analyzer decides it), and its reason is
  // already in `degradations` before the `continue` runs.
  const ownedIds = new Set<string>();
  for (const m of candidates) {
    const facts = factsById.get(m.waMessageId);
    if (!facts) continue; // extraction failed; already reported above.
    const hand = (why: string) =>
      degradations.push(
        `${ADMIN_OPS_APPLY_DEGRADED_PREFIX} ${m.waMessageId}: ${why} — ` +
          `handing this message back to the analyzer`,
      );

    if (facts.kind !== "admin") {
      hand(`the admin extractor returned "${facts.kind}" facts`);
      continue;
    }

    if (facts.action === "other") {
      // The mega-prompt still models admin intents this route does not:
      // `show_teams_request` phrasings that land here, stats asks, and
      // anything §14.3 calls "the least designed part of this document".
      // A silent shrug is the failure this design exists to remove.
      hand("admin action \"other\" has no deterministic handler on this path");
      continue;
    }

    if (facts.action === "bulk_payment") {
      if (!state.features.paymentTracking) {
        // The org-level kill switch (`route.ts:3779-3786`). Either way
        // the bot is silent; going through the analyzer keeps the
        // `AnalyzedMessage` trail identical to today's.
        hand("payment tracking is off for this org");
        continue;
      }
      if (!paymentMatchId) {
        hand(
          `no genuinely COMPLETED, non-historical match to credit against ` +
            `(last played: ${completed ? `${completed.id} (${completed.status})` : "none"})`,
        );
        continue;
      }
    }

    if (facts.action === "reminder" && m.senderUserId && muted.has(m.senderUserId)) {
      // The per-category opt-out (`route.ts:3955-3967`). The player
      // asked MatchTime to stop DMing them and the shipped path answers
      // that out loud with a 🔕 rather than swallowing the request. That
      // sentence lives in the analyzer; a second wording of it here is
      // how two bots start disagreeing in one group.
      hand("the sender has muted reminder DMs (subReminderDm=false)");
      continue;
    }

    ownedIds.add(m.waMessageId);
  }
  if (ownedIds.size === 0) return empty(degradations);

  // ── Stage 3: the engine, over the WHOLE window ─────────────────────
  const engineMessages: EngineMessage[] = messages.map((m) => ({
    id: m.waMessageId,
    body: m.body,
    senderUserId: m.senderUserId,
    senderName: m.senderName ?? m.authorName,
    tagged: m.tagged,
    route: m.route ?? "none",
    facts: ownedIds.has(m.waMessageId)
      ? (factsById.get(m.waMessageId) ?? { kind: "none" })
      : { kind: "none" },
    degraded: null,
  }));

  let result: EngineResult;
  try {
    result = (deps.decide ?? decideDefault)({ messages: engineMessages, state, now });
  } catch (err) {
    const detail = `${ADMIN_OPS_APPLY_DEGRADED_PREFIX} the engine threw (${
      err instanceof Error ? err.message : String(err)
    }); the analyzer keeps the batch`;
    console.error("[admin-ops-engine] the engine threw:", err);
    return empty([...degradations, detail]);
  }
  for (const d of result.degradations) {
    degradations.push(`[${d.stage}${d.messageId ? ` ${d.messageId}` : ""}] ${d.detail}`);
  }

  // ── THE WRITE ASSERTION ────────────────────────────────────────────
  //
  // This path applies exactly three kinds and refuses the batch over
  // anything else. A write it does not understand would have no
  // authorisation pass and nowhere to land, and it would be LOST rather
  // than refused — the shape four dead seatbelts had on 2026-08-31.
  const payments: EnginePaymentWrite[] = [];
  const reminders: EngineReminderWrite[] = [];
  const recruitByMessage = new Map<string, number | null>();
  const foreign: string[] = [];
  for (const w of result.writes) {
    if (!ownedIds.has(w.sourceMessageId)) {
      foreign.push(`${w.kind} (from an unowned message)`);
      continue;
    }
    if (w.kind === "payment_credit") payments.push(w);
    else if (w.kind === "reminder") reminders.push(w);
    else if (w.kind === "recruit_blast") recruitByMessage.set(w.sourceMessageId, w.lookbackMatches);
    else foreign.push(w.kind);
  }
  if (foreign.length > 0) {
    const detail =
      `${ADMIN_OPS_APPLY_DEGRADED_PREFIX} the engine proposed ${foreign.length} write(s) this ` +
      `path cannot apply (${[...new Set(foreign)].join(", ")}); owning nothing and the ` +
      `analyzer keeps the batch`;
    console.error(`[admin-ops-engine] ${detail}`);
    return empty([...degradations, detail]);
  }

  // ── Stage 3b: APPLY ────────────────────────────────────────────────
  //
  // `recruit_blast` is deliberately absent. See the header.
  const replyByMessage = new Map<string, string>();
  const failedIds = new Set<string>();
  const actedIds = new Set<string>();

  for (const w of payments) {
    if (!paymentMatchId) {
      // Unreachable: ownership refused a bulk_payment without a target.
      // Asserted anyway, because "unreachable" is what the comments on
      // four dead seatbelts said.
      degradations.push(
        `${ADMIN_OPS_APPLY_DEGRADED_PREFIX} ${w.sourceMessageId}: a payment credit reached ` +
          `the apply layer with no target match; refused`,
      );
      failedIds.add(w.sourceMessageId);
      continue;
    }
    const sender = messages.find((m) => m.waMessageId === w.sourceMessageId);
    const applied = await applyPaymentCredit({
      matchId: paymentMatchId,
      write: w,
      // The ADMIN who typed it, never the payer. `handleAdmin` has
      // already established that the sender is one.
      recordedByUserId: sender?.senderUserId ?? w.payerUserId,
      deps,
    });
    if (!applied.ok) {
      degradations.push(
        `${ADMIN_OPS_APPLY_DEGRADED_PREFIX} ${w.sourceMessageId}: crediting ` +
          `${w.count} payment(s) to ${w.payerName} on match ${paymentMatchId} failed ` +
          `(${applied.error})`,
      );
      failedIds.add(w.sourceMessageId);
      continue;
    }
    // The ack is built from what LANDED, not from what was asked for —
    // and it REPLACES the composer's generic `payment_ack`, because the
    // shipped sentence carries the unpaid count the chase depends on and
    // the composer cannot see payment state at all.
    replyByMessage.set(w.sourceMessageId, composePaymentAck(applied, w.payerName));
    actedIds.add(w.sourceMessageId);
  }

  for (const w of reminders) {
    const sender = messages.find((m) => m.waMessageId === w.sourceMessageId);
    const applied = await applyReminder({
      write: w,
      name: sender?.senderName ?? sender?.authorName ?? null,
      note: w.note,
      deps,
    });
    if (!applied.ok) {
      degradations.push(
        `${ADMIN_OPS_APPLY_DEGRADED_PREFIX} ${w.sourceMessageId}: queueing the reminder for ` +
          `${w.whenLabel} failed (${applied.error})`,
      );
      failedIds.add(w.sourceMessageId);
      continue;
    }
    actedIds.add(w.sourceMessageId);
  }

  // ── Stage 4: composition, AFTER the apply ──────────────────────────
  const composed = compose(result);
  const composedByMessage = new Map<string, string[]>();
  for (const u of composed.utterances) {
    if (u.messageId === null) {
      degradations.push(
        `${ADMIN_OPS_APPLY_DEGRADED_PREFIX} a batch-level post was composed on the admin path; dropped`,
      );
      continue;
    }
    if (!ownedIds.has(u.messageId)) continue;
    const list = composedByMessage.get(u.messageId) ?? [];
    list.push(u.text);
    composedByMessage.set(u.messageId, list);
  }
  // A payment ack computed from what the apply layer ACTUALLY DID wins
  // over the composer's `payment_ack`, which knows nothing about payment
  // state and so cannot carry the unpaid count the chase depends on.
  // Everything else the composer produced stands.
  for (const [id, list] of composedByMessage) {
    if (replyByMessage.has(id)) continue;
    replyByMessage.set(id, list.join("\n\n"));
  }
  const reactByMessageId = new Map(composed.reacts.map((r) => [r.messageId, r.emoji]));
  for (const n of composed.operatorNotes) {
    if (!degradations.includes(n)) degradations.push(n);
  }

  // ── Per-message outcomes ───────────────────────────────────────────
  const outcomes = new Map<string, AdminOpsMessageOutcome>();
  for (const m of messages) {
    if (!ownedIds.has(m.waMessageId)) continue;
    const engineOutcome = result.outcomes.find((o) => o.messageId === m.waMessageId);
    const facts = factsById.get(m.waMessageId);
    const action = facts?.kind === "admin" ? (facts as AdminFacts).action : "other";
    const failed = failedIds.has(m.waMessageId);
    const machineReasons = (engineOutcome?.reasons ?? []).join("; ");
    const isRecruit = recruitByMessage.has(m.waMessageId);

    // §3.2 S7: a write that threw says nothing at all.
    const reply = failed ? null : (replyByMessage.get(m.waMessageId) ?? null);
    const react = failed
      ? null
      : (reactByMessageId.get(m.waMessageId) ??
        // The shipped reacts, carried rather than moved into the engine:
        // losing them would be a visible change on a flag advertised as
        // a like-for-like move. `route.ts:3911` (payment) and `:3990`
        // (reminder).
        (actedIds.has(m.waMessageId) && action === "bulk_payment"
          ? "👍"
          : actedIds.has(m.waMessageId) && action === "reminder"
            ? "⏰"
            : null));

    outcomes.set(m.waMessageId, {
      waMessageId: m.waMessageId,
      route: m.route as Route,
      reply,
      react,
      // The vocabulary `AnalysisIntent` already uses, so the admin log
      // and the nightly sweeps need no new cases.
      intent:
        action === "bulk_payment"
          ? "bulk_payment_credit"
          : action === "reminder"
            ? "reminder_request"
            : isRecruit
              ? "recruit_recent"
              : "noise",
      action: failed ? "none" : actedIds.has(m.waMessageId) ? action : react ? "react" : reply ? "reply" : "none",
      reasoning:
        `${ADMIN_OPS_HANDLED_BY} (${m.route}): ${machineReasons || "no rule fired"}` +
        (failed ? "; the write FAILED and nothing was said" : ""),
      recruitRequest: isRecruit,
      recruitLookbackMatches: recruitByMessage.get(m.waMessageId) ?? null,
      writeFailed: failed,
    });
  }

  return { ownedIds, outcomes, degradations, cost: { ...cost, ms: Date.now() - t0 } };
}

/**
 * WHAT THE ADMIN-OPS ENGINE DID, AND WHAT IT LOST, for the operator.
 *
 * Pure and exported for the reason `describeEngineBatch` is: the same
 * lines were once composed behind `if (ownedIds.size > 0)`, which
 * silences them in exactly the case they exist for.
 */
export function describeAdminOpsBatch(
  batch: AdminOpsBatchResult,
  batchSize: number,
): { warns: string[]; info: string | null } {
  const warns = batch.degradations.map((d) => `[analyze] admin-ops-engine degraded: ${d}`);
  const info =
    batch.ownedIds.size > 0 || batch.degradations.length > 0
      ? `[analyze] admin-ops-engine: decided ${batch.ownedIds.size}/${batchSize} message(s), ` +
        `$${batch.cost.usd.toFixed(5)} across ${batch.cost.calls} extractor call(s) ` +
        `in ${batch.cost.ms}ms`
      : null;
  return { warns, info };
}
