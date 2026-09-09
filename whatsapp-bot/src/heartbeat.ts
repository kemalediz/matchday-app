/**
 * ONE SIGNAL OFF THE RASPBERRY PI.
 *
 * ── The problem, in the 2026-08-30 audit's words ─────────────────────
 *
 *   "The single biggest problem is not the injected layer at all — it is
 *    that every failure signal is a `console.error` on a Raspberry Pi
 *    that nobody reads. There is no heartbeat, no server-side staleness
 *    check, no alert. That is why August cost three days."
 *
 * `degraded.ts` writes beautifully specific CRITICAL lines. `send-result.ts`
 * says exactly what a NULL `waMessageId` costs. `smart-analysis.ts` prints
 * `seen=340 buffered=0` on every empty flush. All of it goes to `bot.log`,
 * on a Pi, in a cupboard. This module is how those numbers leave the
 * building.
 *
 * ── Why the counters are cumulative per PROCESS ──────────────────────
 *
 * Because a delta needs two snapshots and a story about what happens when
 * the process restarts between them, and every rule the server applies
 * (`src/lib/bot-health.ts`) is expressible as "has this EVER happened
 * since this process started". A per-process counter is also
 * self-clearing: deploy a fix, the bot restarts, the counters go to zero,
 * and the alert stops on its own rather than needing somebody to
 * acknowledge it.
 *
 * ── Why this file is pure ────────────────────────────────────────────
 *
 * Everything decided here is decided the same way in a test as on the Pi.
 * The transport (`postHeartbeat` in `api.ts`) and the wiring (the flush
 * timer in `smart-analysis.ts`) are the parts that can only be observed
 * live; the parts that can be reasoned about are here, where they can be
 * pinned.
 */

/**
 * Per-process tallies of what the inbound path did with what it was
 * handed. See `HealthCounters` in `src/lib/bot-health.ts` for which
 * alert rule reads each one and why its threshold is what it is.
 */
export interface BotCounters {
  /** `enqueueForAnalysis` calls. */
  seen: number;
  /** Messages that made it onto a group buffer. */
  buffered: number;
  /** Of those, how many needed a synthesised waMessageId. */
  synthetic: number;
  /** How many had a REAL id rebuilt from the message key's parts. */
  reconstructed: number;
  /** Skipped because they were not a group (@g.us) message. */
  notGroup: number;
  /** Enrichments that fell back to the raw payload. */
  degradedEnrichment: number;
  /**
   * Buffered messages carrying NEITHER a phone NOR a usable name.
   *
   * This is the audit's §3 in a single number. Such a message cannot be
   * attributed to anybody, registers no attendance, and returns HTTP 200
   * while doing it. Until 2026-09-09 it was also excluded by construction
   * from the group nudge and the admin queue written to catch exactly it.
   */
  nameless: number;
  /** Reactions that could not be placed. */
  reactFailures: number;
  /** Analyze POSTs that failed and were requeued. */
  flushFailures: number;
  /** Messages abandoned past the retry ceiling — permanently lost. */
  droppedMessages: number;
}

export function emptyCounters(): BotCounters {
  return {
    seen: 0,
    buffered: 0,
    synthetic: 0,
    reconstructed: 0,
    notGroup: 0,
    degradedEnrichment: 0,
    nameless: 0,
    reactFailures: 0,
    flushFailures: 0,
    droppedMessages: 0,
  };
}

/**
 * A pushname that is really a bare @lid rendered as digits.
 *
 * Mirrors `isRawDigitName` on the server (`analyze/route.ts`), which
 * refuses to print one as a player's name. It matters here because such
 * a "name" is not an identity: it can never match a roster entry, never
 * become a `UserAlias`, and never resolve a sender. Counting it as a name
 * would make the `nameless` counter agree with the code that produced it
 * and disagree with reality, which is the failure mode this whole file
 * exists to stop.
 */
function isDigitsOnlyName(name: string): boolean {
  const cleaned = name
    .trim()
    .replace(/@?lid$/i, "")
    .replace(/[@\s+().-]/g, "");
  return /^\d{5,}$/.test(cleaned);
}

/**
 * Could the server possibly work out who sent this?
 *
 * The server resolves a sender by phone first and name second. With
 * neither, `resolveSender` returns `{userId: null}`, `createProvisionalByName`
 * refuses to invent a member, and any IN or OUT in the message is
 * silently not written. A name ALONE is enough — exact match, alias,
 * fuzzy first token, or auto-provision — so this is deliberately not
 * "was enrichment perfect", it is "is there any identity at all".
 */
export function isUnattributable(authorPhone: string, authorName: string | null): boolean {
  if (typeof authorPhone === "string" && authorPhone.trim().length > 0) return false;
  const name = (authorName ?? "").trim();
  if (name.length === 0) return true;
  return isDigitsOnlyName(name);
}

export interface HeartbeatPayload {
  groupId: string;
  /** ISO, or null when the process start is somehow unknown. */
  processStartedAt: string | null;
  botVersion: string | null;
  counters: BotCounters;
  degradedCapabilities: string[];
}

/**
 * Build the body of one heartbeat.
 *
 * The counters are COPIED rather than referenced: the live object keeps
 * being incremented by inbound messages while the POST is in flight, and
 * a payload that mutates underneath its own `JSON.stringify` is the kind
 * of bug that only shows up under load, which is exactly when the numbers
 * matter.
 */
export function buildHeartbeat(args: {
  groupId: string;
  counters: BotCounters;
  processStartedAt: Date | null;
  degradedCapabilities: string[];
  botVersion?: string | null;
}): HeartbeatPayload {
  return {
    groupId: args.groupId,
    processStartedAt: args.processStartedAt ? args.processStartedAt.toISOString() : null,
    botVersion: args.botVersion ?? null,
    counters: { ...args.counters },
    // A SET, not a log. The participant sweep runs once per org and the
    // same capability is reported every startup, so without this the
    // column would fill with repeats of one fact.
    degradedCapabilities: [...new Set(args.degradedCapabilities)],
  };
}
