/**
 * Recruit-request plumbing — the two pure pieces of the 2026-09-01 fix.
 *
 * The incident: the owner wrote "Najib is out. We need one more player.
 * Can someone pls come forward". `looksLikeRecruitRequest` matched the
 * SECOND sentence, the recruit fast path peeled the whole message off the
 * LLM batch, and the third-party OUT was never analysed. Najib stayed in,
 * the recruit action saw 10/10, and MatchTime replied "the squad is
 * already full" one line after the owner said a player was out.
 *
 * Recruit is now an extracted verdict FACT (`recruitRequest`), so the
 * regex is gone and both halves of the message survive. What is left to
 * pin here is the pure part: exactly one reply goes out, and the tag
 * decision is a single visible switch.
 */
import { describe, it, expect } from "vitest";
import {
  mergeRecruitReply,
  RECRUIT_BLAST_REQUIRES_TAG,
  RECRUIT_COMMAND_IMPLIES_ADDRESSED,
} from "../recruit-request";

describe("mergeRecruitReply — one outbound message, never two", () => {
  it("joins the LLM reply and the server's recruit line into one string", () => {
    expect(
      mergeRecruitReply("Najib's out — squad is 9/10.", "📣 On it — DM'd 4 recent players."),
    ).toBe("Najib's out — squad is 9/10.\n\n📣 On it — DM'd 4 recent players.");
  });

  it("returns the recruit line alone when the LLM said nothing", () => {
    expect(mergeRecruitReply(null, "📣 On it.")).toBe("📣 On it.");
  });

  it("returns the LLM reply alone when the recruit produced no line", () => {
    expect(mergeRecruitReply("Najib's out.", null)).toBe("Najib's out.");
  });

  it("returns null when neither spoke", () => {
    expect(mergeRecruitReply(null, null)).toBeNull();
    expect(mergeRecruitReply(undefined, undefined)).toBeNull();
  });

  it("treats whitespace-only as silence", () => {
    expect(mergeRecruitReply("   \n ", "📣 On it.")).toBe("📣 On it.");
    expect(mergeRecruitReply("Najib's out.", "\t\n")).toBe("Najib's out.");
    expect(mergeRecruitReply("  ", "  ")).toBeNull();
  });

  it("never says the same thing twice", () => {
    expect(mergeRecruitReply("Same line", "Same line")).toBe("Same line");
  });

  it("always returns ONE string — never an array, never two sends", () => {
    const merged = mergeRecruitReply("a", "b");
    expect(typeof merged).toBe("string");
    expect(merged!.split("\n\n")).toHaveLength(2); // one message, two paragraphs
  });
});

describe("RECRUIT_COMMAND_IMPLIES_ADDRESSED", () => {
  it("is a single boolean switch, so the contract widening is revertible on one line", () => {
    expect(typeof RECRUIT_COMMAND_IMPLIES_ADDRESSED).toBe("boolean");
  });

  it("is still ON — the 2026-09-01 incident's fix is not what changed", () => {
    // The side-request path ("Najib is out. We need one more player.")
    // keeps working untagged. That is the incident, and it is not the
    // thing 2026-09-06 tightened.
    expect(RECRUIT_COMMAND_IMPLIES_ADDRESSED).toBe(true);
  });
});

describe("RECRUIT_BLAST_REQUIRES_TAG — the bulk command, not the side request", () => {
  it("is a single boolean switch, revertible on one line like its sibling", () => {
    expect(typeof RECRUIT_BLAST_REQUIRES_TAG).toBe("boolean");
  });

  it("is ON: an explicit bulk-DM command needs an @Match Time tag", () => {
    expect(RECRUIT_BLAST_REQUIRES_TAG).toBe(true);
  });

  it("holds AT THE SAME TIME as the 2026-09-01 widening — they answer different questions", () => {
    // One asks "may MatchTime act on the REST of a message it was
    // clearly commanded by?" (yes, since 2026-09-01). The other asks
    // "may an untagged message start a 20-person mass DM?" (no, since
    // 2026-09-06). They are two constants and not one so that reverting
    // either leaves the other where it is — and this asserts the pair
    // that ships, which is BOTH on. Collapsing them into one switch
    // would make the incident fix and the ban-risk backstop the same
    // line, which is how one gets reverted by accident with the other.
    expect([RECRUIT_COMMAND_IMPLIES_ADDRESSED, RECRUIT_BLAST_REQUIRES_TAG]).toEqual([true, true]);
  });
});
