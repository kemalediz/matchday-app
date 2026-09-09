/**
 * THE CLAUSE PEEL — the unit tests for the mechanism that ends the
 * terminal-short-circuit bug class in `api/whatsapp/analyze/route.ts`.
 *
 * Six production incidents have the same shape: a fast path matched
 * PART of a message, claimed the WHOLE message, and every other clause
 * in it was destroyed. The most recent, still unfixed at the time these
 * tests were written:
 *
 *   "@Match Time swap Elvin with Raihan, and I'm out"
 *      → the swap applied, the sender stayed CONFIRMED.
 *
 * `peelClause` is the same move `registerForEntryRequiresTag` made one
 * layer down on 2026-09-08: ask the question PER CLAUSE, not per
 * message. A fast path claims the clause it recognises; the rest of the
 * body carries on down the pipeline.
 *
 * THE SAFETY PROPERTY THESE TESTS EXIST TO PIN: the split can only ever
 * ADD a residual. Every body a fast path owns today, it still owns —
 * because when no split produces a matching clause, the WHOLE body is
 * the last fallback. A clause peel can never make a handled message
 * unhandled, and `never loses a body the predicate matched` says so
 * over every shape in this file.
 */
import { describe, it, expect } from "vitest";
import {
  splitClauses,
  peelClause,
  mergeOneReply,
  applyClauseReports,
  type ClauseReport,
  type MergeableResult,
} from "../clause-peel";

describe("splitClauses — what counts as a clause boundary", () => {
  // The terminator STAYS on the clause it ends. What a peel hands
  // onward should read the way the sender wrote it, not the way a
  // tokeniser left it.
  it("splits on a sentence terminator, keeping it", () => {
    expect(splitClauses("Do not regenerate. Swap Elvin with Raihan")).toEqual([
      "Do not regenerate.",
      "Swap Elvin with Raihan",
    ]);
  });

  it("splits on a newline", () => {
    expect(splitClauses("David is OUT\nthe other can go to bench")).toEqual([
      "David is OUT",
      "the other can go to bench",
    ]);
  });

  it("splits on a semicolon", () => {
    expect(splitClauses("swap Ali with Omar; I'm out")).toEqual([
      "swap Ali with Omar",
      "I'm out",
    ]);
  });

  it("splits on a comma FOLLOWED BY a coordinator — the 2026-09-08 shape", () => {
    expect(splitClauses("@Match Time swap Elvin with Raihan, and I'm out")).toEqual([
      "@Match Time swap Elvin with Raihan",
      "I'm out",
    ]);
  });

  it("strips the leading coordinator off the clause it opens", () => {
    expect(splitClauses("swap Ali with Omar. But I'm out")).toEqual([
      "swap Ali with Omar.",
      "I'm out",
    ]);
  });

  // ── THE BOUNDARIES DELIBERATELY NOT TAKEN ────────────────────────────
  //
  // A BARE "and" is not a boundary. "swap the reds and yellows" and
  // "dm me who's in and who's out" are single requests, and splitting
  // them would break two shipped features to fix a third. The cost is
  // stated in the route: "swap A with B and I'm out" (no comma) is not
  // peeled and behaves exactly as it does today.
  it("does NOT split on a bare 'and'", () => {
    expect(splitClauses("swap the reds and yellows")).toEqual(["swap the reds and yellows"]);
    expect(splitClauses("dm me who's in and who's out")).toEqual([
      "dm me who's in and who's out",
    ]);
  });

  // A BARE comma is not a boundary either. `parseSwapNames` accepts
  // "swap Nabeel, Adam" as a separator, and "my stats, I'm in the top 5
  // right?" is one thought whose second half reads as an attendance
  // claim only when it is torn off the first.
  it("does NOT split on a bare comma", () => {
    expect(splitClauses("please swap Nabeel, Adam")).toEqual(["please swap Nabeel, Adam"]);
    expect(splitClauses("my stats, I'm in the top 5 right?")).toEqual([
      "my stats, I'm in the top 5 right?",
    ]);
  });

  it("drops empty pieces and trims", () => {
    expect(splitClauses("  in!!  \n\n  ")).toEqual(["in!!"]);
    expect(splitClauses("")).toEqual([]);
  });

  it("keeps a decimal number whole", () => {
    expect(splitClauses("we won 5.5 to 2")).toEqual(["we won 5.5 to 2"]);
  });
});

describe("peelClause — a fast path claims a clause, not a message", () => {
  const isSwap = (c: string) => /\bswap\b/i.test(c);

  it("peels the swap clause and hands back the sender's own OUT — incident #6", () => {
    expect(peelClause("@Match Time swap Elvin with Raihan, and I'm out", isSwap)).toEqual({
      consumed: "@Match Time swap Elvin with Raihan",
      residual: "I'm out",
    });
  });

  it("owns the WHOLE body when there is nothing else in it", () => {
    expect(peelClause("@Match Time swap Elvin with Raihan", isSwap)).toEqual({
      consumed: "@Match Time swap Elvin with Raihan",
      residual: "",
    });
  });

  it("falls back to the whole body when no single clause matches", () => {
    // The split breaks the phrase the predicate needs; the fallback is
    // the whole body, so the message is still owned.
    const seesBothNames = (c: string) => /swap\s+\w+,\s*\w+/i.test(c);
    expect(peelClause("please swap Nabeel, Adam", seesBothNames)).toEqual({
      consumed: "please swap Nabeel, Adam",
      residual: "",
    });
  });

  it("returns null when the predicate matches nothing at all", () => {
    expect(peelClause("what time is kickoff?", isSwap)).toBeNull();
  });

  it("takes the FIRST matching clause and leaves the rest in order", () => {
    expect(
      peelClause("I'm out. swap Ali with Omar. swap Ben with Cem", isSwap),
    ).toEqual({
      consumed: "swap Ali with Omar.",
      residual: "I'm out. swap Ben with Cem",
    });
  });

  it("never returns an empty consumed clause", () => {
    const always = () => true;
    expect(peelClause("   ", always)).toBeNull();
  });

  // ── OWNERSHIP DOES NOT WIDEN ─────────────────────────────────────────
  //
  // The predicate is applied to the WHOLE body first, and a `false`
  // there is the end of it. Without this, a clause could match where the
  // body does not and the peel would start owning messages it declines
  // today — a widening smuggled in by a change whose entire claim is
  // that it takes nothing away.
  it("refuses a body the predicate declines, even when a CLAUSE matches", () => {
    const isSwap = (c: string) => /\bswap\b/i.test(c);
    const bodyOnly = (c: string) => c === "swap Ali with Omar. and something else";
    expect(peelClause("swap Ali with Omar. and something else", isSwap)).not.toBeNull();
    // Same body, a predicate that only recognises the WHOLE of it: no
    // clause matches, so the whole body is consumed and nothing leaks.
    expect(peelClause("swap Ali with Omar. and something else", bodyOnly)).toEqual({
      consumed: "swap Ali with Omar. and something else",
      residual: "",
    });
    // And a predicate that recognises a clause but NOT the body owns
    // nothing at all.
    const clauseOnly = (c: string) => c === "I'm out";
    expect(peelClause("swap Ali with Omar. I'm out", clauseOnly)).toBeNull();
  });

  // THE SAFETY PROPERTY. Nothing a fast path owns today stops being
  // owned: whatever the split does, the whole body is the last fallback.
  it("never loses a body the predicate matched", () => {
    const bodies = [
      "@Match Time swap Elvin with Raihan, and I'm out",
      "@Match Time swap Elvin with Raihan",
      "please swap Nabeel, Adam",
      "swap the reds and yellows",
      "do not regenerate the teams. Instead swap Elvin with Raihan and share us the teams",
      "swap Ali with Omar; I'm out",
    ];
    for (const b of bodies) {
      expect(peelClause(b, isSwap), b).not.toBeNull();
    }
  });
});

describe("mergeOneReply — MatchTime replies once or not at all", () => {
  it("joins two sentences into ONE outbound message", () => {
    expect(mergeOneReply("👋 You're out, Kemal.", "🔁 Raihan takes Elvin's place.")).toBe(
      "👋 You're out, Kemal.\n\n🔁 Raihan takes Elvin's place.",
    );
  });
  it("passes either half through alone", () => {
    expect(mergeOneReply(null, "🔁 Swapped.")).toBe("🔁 Swapped.");
    expect(mergeOneReply("👋 Out.", null)).toBe("👋 Out.");
  });
  it("treats whitespace as silence", () => {
    expect(mergeOneReply("   ", "  ")).toBeNull();
    expect(mergeOneReply(undefined, undefined)).toBeNull();
  });
  it("collapses two identical lines rather than saying them twice", () => {
    expect(mergeOneReply("🔁 Swapped.", "🔁 Swapped.")).toBe("🔁 Swapped.");
  });
});

describe("applyClauseReports — two owners wrote, one speaks", () => {
  const SWAP: ClauseReport = {
    handledBy: "fast-path",
    intent: "team_swap",
    action: "team-swap",
    reasoning: "team-slot-transfer applied",
    react: "✅",
    reply: "🔁 Ian takes Pat's place.",
  };

  /** Collects what `augmentAnalysis` was asked to do. */
  function recorder() {
    const calls: Array<Record<string, unknown>> = [];
    return {
      calls,
      augment: async (a: Record<string, unknown>) => {
        calls.push(a);
      },
    };
  }

  it("merges into the owner's ONE result rather than pushing a second", async () => {
    const results: MergeableResult[] = [
      { waMessageId: "m1", handledBy: "llm", intent: "out", react: "👋", reply: "👋 You're out." },
    ];
    const rec = recorder();
    await applyClauseReports({
      reports: new Map([["m1", SWAP]]),
      results,
      augment: rec.augment,
    });
    expect(results).toHaveLength(1);
    expect(results[0].reply).toBe("👋 You're out.\n\n🔁 Ian takes Pat's place.");
  });

  // The owner's react describes the write that actually landed, and for
  // a sender's own attendance it has already been reconciled against the
  // final database row. The fast path's only fills a hole.
  it("keeps the OWNER's react and lets the fast path fill an empty one", async () => {
    const withReact: MergeableResult[] = [
      { waMessageId: "m1", handledBy: "llm", intent: "out", react: "👋", reply: null },
    ];
    const withoutReact: MergeableResult[] = [
      { waMessageId: "m1", handledBy: "llm", intent: "out", react: null, reply: null },
    ];
    const rec = recorder();
    await applyClauseReports({ reports: new Map([["m1", SWAP]]), results: withReact, augment: rec.augment });
    await applyClauseReports({ reports: new Map([["m1", SWAP]]), results: withoutReact, augment: rec.augment });
    expect(withReact[0].react).toBe("👋");
    expect(withoutReact[0].react).toBe("✅");
  });

  it("keeps the owner's LABEL and appends the fast path's outcome to the row", async () => {
    const results: MergeableResult[] = [
      { waMessageId: "m1", handledBy: "llm", intent: "out", react: "👋", reply: null },
    ];
    const rec = recorder();
    await applyClauseReports({ reports: new Map([["m1", SWAP]]), results, augment: rec.augment });
    expect(results[0].intent).toBe("out");
    expect(results[0].handledBy).toBe("llm");
    // The row records BOTH halves; neither replaces the other.
    expect(rec.calls[0]).toMatchObject({
      waMessageId: "m1",
      action: "team-swap",
      reasoningSuffix: "team-slot-transfer applied",
    });
    expect(rec.calls[0].handledBy).toBeUndefined();
  });

  // When nobody owned the residual, the ONLY thing that happened to the
  // message is what the fast path did — so the admin log must say
  // `team_swap`, not `noise`, or the log and the world disagree.
  it("RELABELS when the owner recorded nothing", async () => {
    const results: MergeableResult[] = [
      { waMessageId: "m1", handledBy: "ignored", intent: "noise", react: null, reply: null },
    ];
    const rec = recorder();
    await applyClauseReports({ reports: new Map([["m1", SWAP]]), results, augment: rec.augment });
    expect(results[0].handledBy).toBe("fast-path");
    expect(results[0].intent).toBe("team_swap");
    expect(results[0].react).toBe("✅");
    expect(rec.calls[0]).toMatchObject({ handledBy: "fast-path", intent: "team_swap" });
  });

  it("logs rather than invents when there is no result to merge into", async () => {
    const results: MergeableResult[] = [];
    const rec = recorder();
    await applyClauseReports({ reports: new Map([["m1", SWAP]]), results, augment: rec.augment });
    expect(results).toHaveLength(0);
    expect(rec.calls).toHaveLength(0);
  });
});
