import { describe, it, expect } from "vitest";
import { planUnresolvedNudge } from "@/lib/unresolved-nudge";

const base = {
  senderResolved: false,
  attendanceRelevant: true,
  matchId: "match-1",
  authorName: "Shahrokh",
  dropping: false,
};

describe("planUnresolvedNudge — when it stays quiet", () => {
  it("says nothing when the sender WAS resolved", () => {
    expect(planUnresolvedNudge({ ...base, senderResolved: true }).applies).toBe(false);
  });

  it("says nothing about banter", () => {
    expect(planUnresolvedNudge({ ...base, attendanceRelevant: false }).applies).toBe(false);
  });

  it("says nothing when there is no match to talk about", () => {
    expect(planUnresolvedNudge({ ...base, matchId: null }).applies).toBe(false);
  });
});

describe("planUnresolvedNudge — the nameless sender", () => {
  it("FIRES for a message with no name at all", () => {
    // The 2026-08-30 audit's sharpest finding: the one mechanism written
    // for this failure class was gated on `(authorName ?? "").trim().length
    // >= 1` — the very field that degradation destroys. So the single case
    // it existed for was the single case it could not see.
    const plan = planUnresolvedNudge({ ...base, authorName: null });
    expect(plan.applies).toBe(true);
    expect(plan.reply).not.toBeNull();
  });

  it("does not print an empty name into the group", () => {
    const plan = planUnresolvedNudge({ ...base, authorName: "  " });
    expect(plan.reply).not.toContain("**");
    expect(plan.reply).toMatch(/don't recognise/);
  });

  it("gives every nameless sender on a match ONE shared dedupe key", () => {
    // There is no name to key on, so the honest key is "one unknown-sender
    // nudge per match". The alternative — a key per message — would post
    // the same sentence for every unattributable message in a batch, which
    // is the group spam that gets the bot muted.
    const a = planUnresolvedNudge({ ...base, authorName: null });
    const b = planUnresolvedNudge({ ...base, authorName: "" });
    expect(a.dedupeKey).toBe(b.dedupeKey);
    expect(a.dedupeKey).toContain("match-1");
  });

  it("keys a NAMED sender separately from the nameless bucket", () => {
    const named = planUnresolvedNudge({ ...base, authorName: "Shahrokh" });
    const nameless = planUnresolvedNudge({ ...base, authorName: null });
    expect(named.dedupeKey).not.toBe(nameless.dedupeKey);
  });
});

describe("planUnresolvedNudge — the copy", () => {
  it("names the player when there is a name", () => {
    const plan = planUnresolvedNudge({ ...base, authorName: "Shahrokh" });
    expect(plan.reply).toContain("Shahrokh");
    expect(plan.reply).toContain("join");
  });

  it("says drop out when they were leaving", () => {
    const plan = planUnresolvedNudge({ ...base, dropping: true });
    expect(plan.reply).toContain("drop out");
  });

  it("never prints a bare @lid number as a name", () => {
    // RC4 of the 2026-06-12 Sutton Lads incident.
    const plan = planUnresolvedNudge({ ...base, authorName: "158055467598020" });
    expect(plan.applies).toBe(true);
    expect(plan.reply).not.toContain("158055467598020");
    expect(plan.reply).toMatch(/don't recognise/);
  });

  it("normalises the key so two spellings of one pushname share a nudge", () => {
    const a = planUnresolvedNudge({ ...base, authorName: "Élnur" });
    const b = planUnresolvedNudge({ ...base, authorName: "elnur" });
    expect(a.dedupeKey).toBe(b.dedupeKey);
  });

  it("uses plain English, with none of the internal vocabulary", () => {
    const plan = planUnresolvedNudge({ ...base, authorName: null });
    for (const jargon of ["pushname", "@lid", "resolver", "authorName", "null"]) {
      expect(plan.reply!.toLowerCase()).not.toContain(jargon.toLowerCase());
    }
  });
});
