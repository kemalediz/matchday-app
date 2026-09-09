/**
 * STAGE 4 — COMPOSITION.
 *
 * §6.4: "Every outgoing message is composed from the database AFTER the
 * writes land. Numbers and names are never model-authored, so they
 * cannot be wrong, so nothing needs to check them afterwards."
 *
 * That last clause is the deletion of `enforceCanonicalRoster` — 140
 * lines of regex in six sub-passes, every one of which exists because
 * the model authors the squad text and gets it wrong. The correct
 * deterministic composer, `composeSquadStatusPost()`, already exists
 * forty lines above it and is used only as a fallback. Here it is the
 * ONLY path.
 */
import { describe, it, expect } from "vitest";
import { compose } from "../compose";
import { decide } from "../engine";
import { composeSquadStatusPost, displaysSquadState } from "../../group-copy";
import { NOW, SUTTON, attendanceFacts, claim, fullName, msg, world } from "./helpers";
import type { EngineResult, SquadState } from "../types";

function composeFor(state: SquadState, messages: Parameters<typeof decide>[0]["messages"]) {
  const result: EngineResult = decide({ now: NOW, state, messages });
  return { result, out: compose(result) };
}

const TEN = ["kemal", "elvin", "sait", "mustafa", "abid", "idris", "faris", "shaz", "adam", "efat"];

/** A tagged "who's playing?", which is what MAKES the batch-level roster
 *  post since 2026-09-09 (S36b). The post is demand-driven now: an
 *  attendance change on its own produces the ✅ and nothing else, so a
 *  test about the post's CONTENT has to ask for it. */
const rosterAsk = (from: string) =>
  msg({
    from,
    body: "@Match Time who's playing?",
    route: "question",
    tagged: true,
    facts: { kind: "question", topic: "squad", personRef: null, statedCount: null },
  });

describe("the squad post is read out of the projected state", () => {
  it("states the count AFTER the write, never the one before (2026-04-26, Wasim, ef8d801)", () => {
    const state = world({ confirmed: [...TEN, "usama", "karahan", "zair", "wasim"] });
    const { out } = composeFor(state, [
      msg({
        from: "wasim",
        body: "out sorry lads",
        route: "self_att",
        facts: attendanceFacts([claim({ polarity: "out" })]),
      }),
      rosterAsk("adam"),
    ]);
    const text = out.utterances.map((u) => u.text).join("\n");
    expect(text).toContain("13/14");
    expect(text).not.toContain("12/14");
    expect(text).not.toMatch(/full squad/i);
    // The incident omitted a confirmed player from the reordered roster.
    expect(text).toContain("Zair Malik");
  });

  it("lists the bench when there is one, and never invents one when there is not", () => {
    const withBench = world({
      confirmed: [...TEN, "usama", "karahan", "zair", "wasim"],
      bench: ["najib"],
    });
    const a = compose(
      decide({
        now: NOW,
        state: withBench,
        messages: [
          msg({ from: "amir", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
          rosterAsk("adam"),
        ],
      }),
    );
    expect(a.utterances.map((u) => u.text).join()).toMatch(/Bench \(2\)/);

    const noBench = world({ confirmed: TEN });
    const b = compose(
      decide({
        now: NOW,
        state: noBench,
        messages: [
          msg({ from: "amir", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
          rosterAsk("adam"),
        ],
      }),
    );
    expect(b.utterances.map((u) => u.text).join()).not.toMatch(/Bench \(/);
  });

  it("says NOTHING at all for a batch that only changed the squad (2026-09-09)", () => {
    // The other half of the property above, and the reason this file
    // needed `rosterAsk`. Kemal, on the live group: "for every IN, MT is
    // responding with the squad. I think that is overmessaging. Only a
    // tick is enough."
    const { out } = composeFor(world({ confirmed: TEN }), [
      msg({ from: "usama", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
      msg({ from: "karahan", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
    ]);
    expect(out.utterances).toEqual([]);
    // …and the players are still told, by the ✅ each message gets.
    expect(out.reacts.map((r) => r.emoji)).toEqual(["✅", "✅"]);
  });

  it("says exactly one thing for a batch of three squad messages (§3.2 S36)", () => {
    const state = world({ confirmed: TEN });
    const { out } = composeFor(state, [
      msg({ from: "usama", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
      msg({ from: "karahan", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
      msg({
        from: "zair",
        body: "@Match Time how many are we now?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "count", personRef: null, statedCount: null },
      }),
    ]);
    expect(out.utterances).toHaveLength(1);
    expect(out.utterances[0].text).toContain("12/14");
  });
});

describe("questions are answered from state, not from the model", () => {
  it("corrects a wrong stated count with the real number (§3.2 S24)", () => {
    const state = world({ confirmed: [...TEN, "usama"] });
    const { out } = composeFor(state, [
      msg({
        from: "amir",
        body: "@Match Time we're 9/14 right?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "count", personRef: null, statedCount: 9 },
      }),
    ]);
    const text = out.utterances[0].text;
    expect(text).toContain("11");
    expect(text).not.toMatch(/yes.{0,20}9\/14/i);
  });

  it("names the bench and speculates about nothing (§3.2 S16)", () => {
    const state = world({ confirmed: [...TEN, "usama", "najib", "zair", "wasim"], bench: ["karahan"] });
    const { out } = composeFor(state, [
      msg({
        from: "adam",
        body: "@Match Time who's on the bench?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "bench", personRef: null, statedCount: null },
      }),
    ]);
    const text = out.utterances[0].text;
    expect(text).toContain("Karahan");
    expect(text).not.toMatch(/5-a-side|downgrade|if we shrink/i);
  });

  it("answers 'is X coming?' without claiming a registration that never happened", () => {
    const state = world({ confirmed: TEN });
    const { out } = composeFor(state, [
      msg({
        from: "kemal",
        body: "@Match Time is Amir also coming or not?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "person_status", personRef: "Amir", statedCount: null },
      }),
    ]);
    const text = out.utterances[0].text;
    expect(text).toContain("Amir");
    expect(text).not.toMatch(/Amir[^.\n]{0,40}\b(is|'s) (confirmed|in the squad|playing)/);
  });

  it("answers 'who has no number?' with names and never a digit (§3.2 S32)", () => {
    const state = world({
      players: ["kemal", "elvin", "sait", "gary", "walt"],
      confirmed: ["kemal", "elvin", "sait", "gary", "walt"],
      noPhone: ["gary", "walt"],
    });
    const { out } = composeFor(state, [
      msg({
        from: "kemal",
        body: "@Match Time who has no phone number on record?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "phones", personRef: null, statedCount: null },
      }),
    ]);
    const text = out.utterances[0].text;
    expect(text).toContain("gary");
    expect(text).toContain("walt");
    expect(text).not.toMatch(/(?:\+\d[\d\s().-]{8,}\d)|(?:\b0\d{9,10}\b)|(?:\b\d{11,}\b)/);
  });

  it("answers a stats question with NO squad block appended (§3.2 S16, cf6ed22)", () => {
    const state = world({
      confirmed: TEN.slice(0, 6),
      appearances: [
        { userId: "u-kemal", matches: 9 },
        { userId: "u-elvin", matches: 7 },
        { userId: "u-sait", matches: 2 },
      ],
    });
    const { out } = composeFor(state, [
      msg({
        from: "shaz",
        body: "@Match Time who's been the most consistent?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "stats", personRef: null, statedCount: null },
      }),
    ]);
    const text = out.utterances[0].text;
    expect(text).toContain("Kemal");
    expect(text).not.toMatch(/\b\d{1,2}\/14\b/);
    expect(text).not.toMatch(/Reply \*?IN/);
  });

  it("answers 'what are our options?' without naming anyone as benched (§3.2 S34)", () => {
    // 2026-08-30: the model computed 8 − 5 instead of 8 − 10 and told a
    // real customer group that "Najib + Mojib + Mustafa go on the bench"
    // when a switch would have benched nobody. format-switch.ts computes
    // it; the composer copies the answer.
    const state = world({
      confirmed: ["kemal", "elvin", "sait", "mustafa", "abid", "najib", "mojib", "idris"],
      smallerFormats: [{ sportName: "Football 5-a-side", totalPlayers: 10 }],
    });
    const { out } = composeFor(state, [
      msg({
        from: "kemal",
        body: "@Match Time we're only 8, what are our options?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "options", personRef: null, statedCount: null },
      }),
    ]);
    const text = out.utterances[0].text;
    expect(text).not.toMatch(/(Najib|Mojib|Mustafa)[^.\n]{0,60}\bbench\b/);
    expect(text).not.toMatch(/\bgo(?:es)? on the bench\b/);
  });
});

describe("the guest name ask", () => {
  it("asks for one name in the singular", () => {
    const state = world({ confirmed: TEN.slice(0, 7) });
    const { out } = composeFor(state, [
      msg({
        from: "amir",
        body: "@Kemal Ediz my brother can play if needed",
        route: "offer",
        facts: attendanceFacts([
          claim({
            subject: "other",
            personRef: "my brother",
            personNamed: false,
            polarity: "in",
            contingent: true,
            conditionOn: "squad",
          }),
        ]),
      }),
    ]);
    expect(out.utterances[0].text).toMatch(/what(?:'s| is| are) their names?\?/i);
    expect(out.reacts).toHaveLength(0);
  });

  it("asks for names in the plural", () => {
    const state = world({ confirmed: [...TEN, "usama"] });
    const { out } = composeFor(state, [
      msg({
        from: "amir",
        body: "two of my guys can play",
        route: "other_att",
        facts: attendanceFacts([
          claim({ subject: "other", personRef: "two of my guys", personNamed: false, polarity: "in" }),
        ]),
      }),
    ]);
    expect(out.utterances[0].text).toMatch(/what are their names\?/i);
  });
});

describe("the composer cannot say a thing the writes do not support", () => {
  it("says nothing at all when nothing happened", () => {
    const state = world({ confirmed: TEN });
    const { out } = composeFor(state, [
      msg({ from: "ayoub", body: "😂😂😂", route: "none", facts: { kind: "none" } }),
      msg({ from: "sait", body: "anyone watching the derby", route: "none", facts: { kind: "none" } }),
    ]);
    expect(out.utterances).toHaveLength(0);
    expect(out.reacts).toHaveLength(0);
  });

  it("never prints a raw phone number, whatever is in the state", () => {
    const state = world({ confirmed: TEN });
    state.roster[0].name = "+44 7700 900123";
    const { out } = composeFor(state, [
      msg({ from: "usama", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
    ]);
    const text = out.utterances.map((u) => u.text).join("\n");
    expect(text).not.toMatch(/(?:\+\d[\d\s().-]{8,}\d)|(?:\b0\d{9,10}\b)|(?:\b\d{11,}\b)/);
  });

  it("routes degradations to the OPERATOR channel, never to the group", () => {
    const state = world({ noMatch: true });
    const { out } = composeFor(state, [
      msg({ from: "najib", body: "In", route: "self_att", facts: attendanceFacts([claim({})]) }),
    ]);
    expect(out.utterances).toHaveLength(0);
    expect(out.operatorNotes.length).toBeGreaterThan(0);
    expect(out.operatorNotes.join(" ")).toMatch(/no active registration match/i);
  });
});

describe("reactions are derived from the write outcome, not authored", () => {
  it("✅ for a confirmed slot, 🪑 for the bench, 👋 for a drop", () => {
    const state = world({ confirmed: TEN });
    const a = composeFor(state, [
      msg({ from: "usama", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
    ]);
    expect(a.out.reacts[0].emoji).toBe("✅");

    const full = world({ confirmed: [...TEN, "usama", "karahan", "zair", "wasim"] });
    const b = composeFor(full, [
      msg({ from: "najib", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
    ]);
    expect(b.out.reacts[0].emoji).toBe("🪑");

    const c = composeFor(full, [
      msg({
        from: "wasim",
        body: "out",
        route: "self_att",
        facts: attendanceFacts([claim({ polarity: "out" })]),
      }),
    ]);
    expect(c.out.reacts[0].emoji).toBe("👋");
  });
});

// ── §3.2 S16 / S19 · the three answers the 2026-09-06 sweep asked for ──
//
// Each of these was a SILENCE or the wrong answer before this block.
// Twelve tagged questions were replayed against the live Sutton squad on
// 2026-09-06: four produced nothing at all, three answered a roster
// request with a bare count, and one posted a team sheet with nobody on
// it.

describe("a roster question is answered with the roster (2026-09-06 sweep)", () => {
  it("renders the squad post itself, not `We're 11/14`", () => {
    const state = world({ confirmed: [...TEN, "usama"], bench: ["karahan"] });
    const { out } = composeFor(state, [
      msg({
        from: "adam",
        body: "@Match Time who's playing?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "squad", personRef: null, statedCount: null },
      }),
    ]);
    const text = out.utterances[0].text;
    // The point of the change: NAMES, and every one of them.
    for (const who of ["Kemal Ediz", "Usama Tariq", "Karahan Yildiz"]) {
      expect(text).toContain(who);
    }
    // Not an approximation of the roster post — the roster post.
    expect(text).toBe(
      composeSquadStatusPost({
        confirmed: [...TEN, "usama"].map(fullName),
        bench: ["Karahan Yildiz"],
        maxPlayers: 14,
      }),
    );
  });

  it("says it ONCE when the same batch also changed the squad (§3.2 S36)", () => {
    // The roster question is answered BY the batch's own squad post.
    // Two rosters one line apart is the 2026-06-12 Sutton Lads shape.
    const state = world({ confirmed: TEN });
    const { out } = composeFor(state, [
      msg({
        from: "usama",
        body: "in",
        route: "self_att",
        facts: attendanceFacts([claim({ polarity: "in" })]),
      }),
      msg({
        from: "adam",
        body: "@Match Time who's playing?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "squad", personRef: null, statedCount: null },
      }),
    ]);
    expect(out.utterances.filter((u) => /Playing:/.test(u.text))).toHaveLength(1);
  });
});

describe("a fixture question is answered from the match (2026-09-06 sweep)", () => {
  const FIXTURE = {
    kind: "question" as const,
    topic: "fixture" as const,
    personRef: null,
    statedCount: null,
  };

  it("states the kickoff and the venue, and invents neither", () => {
    const state = world({ confirmed: TEN });
    const { out } = composeFor(state, [
      msg({
        from: "adam",
        body: "@Match Time what time is kickoff",
        route: "question",
        tagged: true,
        facts: FIXTURE,
      }),
    ]);
    const text = out.utterances[0].text;
    expect(text).toContain("Tue 21:30");
    expect(text).toContain("Goals North Cheam");
  });

  it("must NOT carry a count, or the shipped composer replaces it with the roster", () => {
    // `displaysSquadState` rule (c): an `N/M` beside squad vocabulary is
    // squad state, and `composeSquadStateReply` then drops the whole
    // answer and posts the roster instead. Someone who asked "what time
    // is kickoff" would get a squad list and no time.
    const state = world({ confirmed: TEN });
    const { out } = composeFor(state, [
      msg({
        from: "adam",
        body: "@Match Time where are we playing",
        route: "question",
        tagged: true,
        facts: FIXTURE,
      }),
    ]);
    expect(displaysSquadState(out.utterances[0].text)).toBe(false);
  });

  it("drops the venue rather than printing 'at' with nothing after it", () => {
    const state = { ...world({ confirmed: TEN }), venue: "" };
    const { out } = composeFor(state, [
      msg({
        from: "adam",
        body: "@Match Time is the game still on",
        route: "question",
        tagged: true,
        facts: FIXTURE,
      }),
    ]);
    expect(out.utterances[0].text).toContain("Tue 21:30");
    expect(out.utterances[0].text).not.toMatch(/\bat\s*$/);
    expect(out.utterances[0].text).not.toMatch(/\bat\s*\./);
  });
});

describe("showing teams that do not exist (2026-09-06 sweep)", () => {
  it("says so, instead of posting two empty team lists", () => {
    // The measured defect: `formatTeamsPost` over two empty arrays
    // rendered "⚽ *Teams for tonight* … *Red*:\n\n\n*Yellow*:\n\n\n" —
    // a team sheet with nobody on it.
    const state = world({ confirmed: TEN });
    const { out } = composeFor(state, [
      msg({
        from: "elvin",
        body: "@Match Time show me the teams",
        route: "balancer",
        tagged: true,
        facts: { kind: "teams", action: "show", includeRefs: [], teamNames: null, swaps: [], pairings: [] },
      }),
    ]);
    const text = out.utterances[0].text;
    expect(text).toMatch(/no teams generated yet/i);
    expect(text).not.toContain("Teams for tonight");
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2026-09-08 · SAYING WHAT WAS NOT DONE (the David incident).
//
// An untagged admin's "David is OUT … the other can go to bench" applies
// the drop and refuses the demote. §9's signature failure is "message
// understood, action silently not taken", and a partially applied
// instruction the owner does not know was partial is exactly that, so
// MatchTime names the half it left alone.
//
// The sentence only ever rides a turn MatchTime was already taking (the
// engine emits the intent beside a write), so it is not a new class of
// unprompted chatter on an untagged message.
// ══════════════════════════════════════════════════════════════════════
describe("a partially applied instruction says which half did not happen", () => {
  const SQUAD = [...TEN, "usama", "karahan", "zair", "mojib"];

  const incident = () =>
    composeFor(world({ players: [...SUTTON, "david"], confirmed: [...SQUAD.slice(0, 13), "david"] }), [
      msg({
        from: "kemal",
        body:
          "David is OUT voluntarily to switch to 5aside.\n\n" +
          "Either @Mojib Jalali or @Najib can be in the main squad and the other can go to bench",
        route: "other_att",
        facts: attendanceFacts([
          claim({ subject: "other", personRef: "David", personNamed: true, polarity: "out" }),
          claim({ subject: "other", personRef: "Mojib", personNamed: true, polarity: "bench" }),
        ]),
      }),
    ]);

  it("names the refused player, the remedy, and nothing else", () => {
    const { out } = incident();
    const text = out.utterances.map((u) => u.text).join("\n");
    expect(text).toContain("I've not moved Mojib Sadat to the bench");
    expect(text).toContain("@Match Time");
  });

  it("does NOT repeat the half it DID do — the squad post is that", () => {
    // Two rosters one line apart is the 2026-06-12 Sutton Lads shape
    // (S36). The refusal sentence talks about the refused half only.
    const { out } = incident();
    const refusal = out.utterances.find((u) => u.text.includes("left alone"))!;
    expect(refusal.text).not.toContain("David");
    // …and the squad post, which carries what DID happen, is still sent:
    // Kemal moved DAVID's row, not his own, so there is no react on
    // David's side of it and the roster is what tells him (S36b).
    expect(out.utterances.some((u) => u.text.includes("/14"))).toBe(true);
  });

  it("is attached to the message it answers, not to the batch", () => {
    const { out } = incident();
    const refusal = out.utterances.find((u) => u.text.includes("left alone"))!;
    expect(refusal.messageId).not.toBeNull();
  });

  it("says nothing at all when the whole message was refused", () => {
    // A bench demote on its own, untagged: nothing is applied, so
    // MatchTime takes no turn and the sentence has none to ride.
    const { out } = composeFor(world({ confirmed: SQUAD }), [
      msg({
        from: "kemal",
        body: "put Mojib on the bench",
        route: "other_att",
        facts: attendanceFacts([
          claim({ subject: "other", personRef: "Mojib", personNamed: true, polarity: "bench" }),
        ]),
      }),
    ]);
    expect(out.utterances).toHaveLength(0);
  });

  it("reads correctly when BOTH a drop and a demote were refused", () => {
    // An ordinary member: his own OUT lands, and the two clauses about
    // other people do not.
    const { out } = composeFor(
      world({ players: [...SUTTON, "david"], confirmed: [...SQUAD.slice(0, 13), "david"] }),
      [
        msg({
          from: "zair",
          body: "I'm out, David is out too and Mojib can go on the bench",
          route: "other_att",
          facts: attendanceFacts([
            claim({ polarity: "out" }),
            claim({ subject: "other", personRef: "David", personNamed: true, polarity: "out" }),
            claim({ subject: "other", personRef: "Mojib", personNamed: true, polarity: "bench" }),
          ]),
        }),
      ],
    );
    const refusal = out.utterances.find((u) => u.text.includes("left alone"))!;
    expect(refusal.text).toContain("I've not taken David out or moved Mojib Sadat to the bench");
  });
});
