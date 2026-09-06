/**
 * §10 STEP 8 — WHAT REPLACES "FALL BACK TO THE ANALYZER".
 *
 * Every owner in the pipeline used to end its failure table with the
 * same line: "→ the analyzer decides this message". Step 8 deletes the
 * analyzer, so every one of those arrows points at nothing, and the
 * question this module answers is what a message nobody owns is now
 * worth telling a human about.
 *
 * The answer has to thread between two failures that are BOTH real:
 *
 *   • §9 names "message understood, action silently not taken" this
 *     product's SIGNATURE failure. Silence with no signal is how Baki's
 *     drop went unnoticed for thirteen days.
 *   • An admin DM for every message nobody owned would fire on the 69.3%
 *     of real traffic that is banter (measured over 1,723 production
 *     messages, PR #35). A nagging operator surface is an ignored one,
 *     which is the same silence with extra steps.
 *
 * So the rule is a ROUTE test and never a content test: a message the
 * router called `none` is banter and is never noted; a message it routed
 * to something actionable and nobody then acted on IS noted. That keeps
 * this module on the right side of the line `gate.ts` draws between a
 * classifier and a seatbelt — it reads a route, not a sentence.
 */
import { describe, expect, it } from "vitest";
import {
  composeOperatorNote,
  OPERATOR_NOTE_MARKER,
  type UnownedMessage,
} from "../operator-note";

function m(over: Partial<UnownedMessage> = {}): UnownedMessage {
  return {
    waMessageId: "wa-1",
    body: "in",
    authorName: "Pete Power",
    route: "self_att",
    ...over,
  };
}

describe("what gets an operator note", () => {
  it("says nothing at all when every message was owned", () => {
    const note = composeOperatorNote({ orgName: "Sutton FC", messages: [], degradations: [] });
    expect(note.noteIds).toEqual([]);
    expect(note.text).toBeNull();
  });

  it("never notes a `none` route — that is banter, and step 5's whole saving", () => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [
        m({ waMessageId: "a", route: "none", body: "😂😂😂" }),
        m({ waMessageId: "b", route: "none", body: "anyone watching the derby" }),
      ],
      degradations: [],
    });
    expect(note.noteIds).toEqual([]);
    expect(note.text).toBeNull();
  });

  it("notes an actionable route nobody owned", () => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [m({ waMessageId: "a", route: "question", body: "@Match Time who's been most consistent?" })],
      degradations: [],
    });
    expect(note.noteIds).toEqual(["a"]);
    expect(note.text).toContain("Sutton FC");
    expect(note.text).toContain("most consistent");
    expect(note.text).toContain("Pete Power");
  });

  it("notes every actionable route, `unsure` included", () => {
    // `unsure` reaching here at all means the attendance engine did not
    // own it — the org has attendance off, there is no match, or the
    // extractor failed. All three are worth a human seeing, because
    // `unsure` is attendance-SHAPED by the router's own definition.
    const routes = [
      "self_att",
      "other_att",
      "offer",
      "question",
      "balancer",
      "score",
      "admin_ops",
      "unsure",
    ] as const;
    for (const route of routes) {
      const note = composeOperatorNote({
        orgName: "Sutton FC",
        messages: [m({ route })],
        degradations: [],
      });
      expect(note.noteIds, `route ${route} was not noted`).toEqual(["wa-1"]);
    }
  });

  it("notes an id with NO route at all — that is §3.2 S1's coverage hole", () => {
    // The 2026-05-25 Ibrahim + Baki incident: two clear drop messages
    // omitted from the verdicts array entirely, and the bot silently
    // no-op'd both. A missing route must never read as a decision.
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [m({ waMessageId: "a", route: undefined })],
      degradations: [],
    });
    expect(note.noteIds).toEqual(["a"]);
    expect(note.text).toContain("no route");
  });

  it("mixes: notes only the actionable ones out of a mostly-banter batch", () => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [
        m({ waMessageId: "a", route: "none", body: "😂" }),
        m({ waMessageId: "b", route: "other_att", body: "@Match Time drop Erdal" }),
        m({ waMessageId: "c", route: "none", body: "https://youtu.be/x" }),
      ],
      degradations: [],
    });
    expect(note.noteIds).toEqual(["b"]);
  });
});

describe("what the note says", () => {
  it("carries the operator reason when a runner explained itself", () => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [m({ waMessageId: "a", route: "balancer", body: "@Match Time rename the teams" })],
      degradations: [
        'answer-batch: degraded — a: team action "rename" still belongs to the balancer',
      ],
    });
    expect(note.text).toContain("rename");
  });

  it("truncates a long body rather than pasting an essay into a DM", () => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [m({ waMessageId: "a", route: "question", body: "x".repeat(400) })],
      degradations: [],
    });
    expect(note.text!.length).toBeLessThan(1200);
    expect(note.text).toContain("…");
  });

  it("names the club, so an admin of two orgs knows which group to look at", () => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [m()],
      degradations: [],
    });
    expect(note.text).toContain("Sutton FC");
  });

  it("always contains the marker the 1-hour dedupe query searches for", () => {
    // The coupling made explicit. `route.ts` suppresses a repeat by
    // `BotJob.text contains OPERATOR_NOTE_MARKER`; if the copy is
    // reworded without the constant, one DM per hour silently becomes
    // one DM per batch, which is how an operator surface becomes noise.
    for (const n of [1, 2, 9]) {
      const note = composeOperatorNote({
        orgName: "Sutton FC",
        messages: Array.from({ length: n }, (_, i) => m({ waMessageId: `wa-${i}` })),
        degradations: [],
      });
      expect(note.text).toContain(OPERATOR_NOTE_MARKER);
    }
  });

  it("says plainly that MatchTime did not reply, which is the whole point of sending it", () => {
    const note = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [m()],
      degradations: [],
    });
    expect(note.text!.toLowerCase()).toContain("didn't respond");
  });

  it("agrees singular and plural", () => {
    const one = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [m({ waMessageId: "a" })],
      degradations: [],
    });
    expect(one.text).toContain("1 message");
    const two = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [m({ waMessageId: "a" }), m({ waMessageId: "b" })],
      degradations: [],
    });
    expect(two.text).toContain("2 messages");
  });

  it("caps how many messages it lists, so a broken batch cannot send a wall of text", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      m({ waMessageId: `wa-${i}`, body: `message number ${i}` }),
    );
    const note = composeOperatorNote({ orgName: "Sutton FC", messages: many, degradations: [] });
    // Every id is still REPORTED (the caller records them); only the DM
    // text is capped.
    expect(note.noteIds).toHaveLength(40);
    expect(note.text).toContain("40 messages");
    expect(note.text).toContain("more");
    expect(note.text!.length).toBeLessThan(2000);
  });
});

describe("the dedupe key", () => {
  it("is stable for the same batch and different for a different one", () => {
    const a = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [m({ waMessageId: "a" })],
      degradations: [],
    });
    const again = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [m({ waMessageId: "a" })],
      degradations: [],
    });
    const other = composeOperatorNote({
      orgName: "Sutton FC",
      messages: [m({ waMessageId: "b" })],
      degradations: [],
    });
    expect(a.dedupeKey).toBe(again.dedupeKey);
    expect(a.dedupeKey).not.toBe(other.dedupeKey);
  });

  it("is null when there is nothing to send", () => {
    const note = composeOperatorNote({ orgName: "Sutton FC", messages: [], degradations: [] });
    expect(note.dedupeKey).toBeNull();
  });
});
