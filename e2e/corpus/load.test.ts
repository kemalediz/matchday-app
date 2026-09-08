/**
 * Unit tests for the corpus LOADER — the thing that turns
 * `incidents.jsonl` into typed cases and refuses to load a corpus that
 * would silently mis-grade a pipeline.
 *
 * The last test loads the REAL corpus file, so a malformed or
 * unsubstantiated case cannot be committed without turning this red.
 */
import { describe, it, expect } from "vitest";
import { parseCorpus, loadCorpus, CORPUS_PATH } from "./load";
import { ALL_PROMPT_SECTIONS } from "./grade";

const good = {
  id: "S6-najib-in-at-full-squad",
  title: "an IN at a full squad must still write",
  sections: ["S6"],
  category: "D",
  provenance: { kind: "commit", ref: "f61a897", date: "2026-05-08", note: "Najib" },
  world: { players: [{ key: "najib", name: "Najib Ahmadi" }] },
  messages: [{ from: "najib", body: "In" }],
  expect: { attendance: [{ player: "najib", status: "BENCH" }] },
  liveOnlyReason: "fixture: the assertion IS the model's classification",
};

const line = (o: unknown) => JSON.stringify(o);

describe("parseCorpus", () => {
  it("parses one case per line and ignores blanks and # comments", () => {
    const cases = parseCorpus([" ", "# a comment", line(good), ""].join("\n"));
    expect(cases).toHaveLength(1);
    expect(cases[0].id).toBe("S6-najib-in-at-full-squad");
  });

  it("rejects a case with no id, title, sections or provenance", () => {
    expect(() => parseCorpus(line({ ...good, id: undefined }))).toThrow(/id/i);
    expect(() => parseCorpus(line({ ...good, title: "" }))).toThrow(/title/i);
    expect(() => parseCorpus(line({ ...good, sections: [] }))).toThrow(/section/i);
    expect(() => parseCorpus(line({ ...good, provenance: undefined }))).toThrow(/provenance/i);
  });

  it("rejects an unknown category or an unknown §3.2 section id", () => {
    expect(() => parseCorpus(line({ ...good, category: "Z" }))).toThrow(/category/i);
    expect(() => parseCorpus(line({ ...good, sections: ["S99"] }))).toThrow(/S99/);
  });

  it("rejects a duplicate case id — two cases would silently merge in the report", () => {
    expect(() => parseCorpus([line(good), line(good)].join("\n"))).toThrow(/duplicate/i);
  });

  it("rejects a case whose expectation names a player the world never had", () => {
    const bad = {
      ...good,
      expect: { attendance: [{ player: "ghostkey", status: "CONFIRMED" }] },
    };
    expect(() => parseCorpus(line(bad))).toThrow(/ghostkey/);
  });

  it("allows a literal (non-key) name when the case declares allowNewMembers", () => {
    const ok = {
      ...good,
      expect: {
        attendance: [{ player: "Shahrokh", status: "CONFIRMED" }],
        allowNewMembers: true,
      },
    };
    expect(parseCorpus(line(ok))).toHaveLength(1);
  });

  it("rejects the same player appearing twice in world.attendance", () => {
    // This one is not hypothetical: a hand-edit put Karahan in both the
    // confirmed list and the bench of the S13 bench-offer case, and it
    // only surfaced as a Postgres primary-key violation 12 cases into a
    // live run. The loader is the right place to catch it.
    const bad = {
      ...good,
      world: {
        players: [
          { key: "najib", name: "Najib Ahmadi" },
          { key: "karahan", name: "Karahan Yildiz" },
        ],
        attendance: [
          { key: "karahan", status: "CONFIRMED" },
          { key: "karahan", status: "BENCH" },
        ],
      },
    };
    expect(() => parseCorpus(line(bad))).toThrow(/karahan/);
  });

  it("rejects a message from a roster key that does not exist", () => {
    expect(() => parseCorpus(line({ ...good, messages: [{ from: "nobody", body: "hi" }] }))).toThrow(
      /nobody/,
    );
  });

  it("rejects an expectation that asserts nothing at all", () => {
    expect(() => parseCorpus(line({ ...good, expect: {} }))).toThrow(/asserts nothing/i);
  });

  it("rejects a case that carries routes but no stubKind", () => {
    const bad = { ...good, messages: [{ from: "najib", body: "In", route: "self_att" }] };
    delete (bad as Record<string, unknown>).liveOnlyReason;
    expect(() => parseCorpus(line(bad))).toThrow(/stubKind/);
  });

  it("rejects the DELETED verdict seam by name, rather than ignoring it", () => {
    // A case ported carelessly from the pre-step-8 format would
    // otherwise load as live-only and quietly stop covering anything.
    const bad = { ...good, messages: [{ from: "najib", body: "In", stub: { intent: "in" } }] };
    expect(() => parseCorpus(line(bad))).toThrow(/VERDICT seam/);
  });

  it("rejects both old stubKind spellings, and an unknown route", () => {
    const routed = (over: Record<string, unknown>) => ({
      ...good,
      liveOnlyReason: undefined,
      messages: [{ from: "najib", body: "In", route: "self_att" }],
      ...over,
    });
    expect(() => parseCorpus(line(routed({ stubKind: "corrected" })))).toThrow(/transcribed/);
    expect(() => parseCorpus(line(routed({ stubKind: "historical" })))).toThrow(/transcribed/);
    expect(() =>
      parseCorpus(
        line({
          ...good,
          liveOnlyReason: undefined,
          stubKind: "transcribed",
          messages: [{ from: "najib", body: "In", route: "attendance" }],
        }),
      ),
    ).toThrow(/route/);
  });

  it("rejects facts with no route to say which extractor they belong to", () => {
    const bad = {
      ...good,
      messages: [{ from: "najib", body: "In", facts: { claims: [] } }],
    };
    expect(() => parseCorpus(line(bad))).toThrow(/route/);
  });

  it("accepts a transcribed case and refuses a liveOnlyReason on it", () => {
    const ok = {
      ...good,
      liveOnlyReason: undefined,
      stubKind: "transcribed",
      messages: [
        { from: "najib", body: "In", route: "self_att", facts: { claims: [{ polarity: "in" }] } },
      ],
    };
    const [c] = parseCorpus(line(ok));
    expect(c.stubKind).toBe("transcribed");
    expect(c.messages[0].route).toBe("self_att");
    expect(() =>
      parseCorpus(line({ ...ok, liveOnlyReason: "cannot have both" })),
    ).toThrow(/liveOnlyReason/);
  });

  it("a case with no route must say WHY it cannot be stubbed", () => {
    // A live-only case never runs in CI. "61 cases" must not be allowed
    // to imply "61 cases in CI", so the exemption is argued case by
    // case rather than left as a silent default.
    const noReason: Record<string, unknown> = { ...good };
    delete noReason.liveOnlyReason;
    expect(() => parseCorpus(line(noReason))).toThrow(/liveOnlyReason/);

    const [c] = parseCorpus(line(good));
    expect(c.stubKind).toBeUndefined();
    expect(c.liveOnlyReason).toBeTruthy();
  });

  it("an adjudication must carry a verdict, an ISO date and a real sentence", () => {
    const adj = (a: unknown) => line({ ...good, adjudication: a });
    expect(() => parseCorpus(adj({ verdict: "maybe", date: "2026-09-08", reason: "x".repeat(30) })))
      .toThrow(/verdict/);
    expect(() => parseCorpus(adj({ verdict: "new_right", date: "yesterday", reason: "x".repeat(30) })))
      .toThrow(/date/);
    expect(() => parseCorpus(adj({ verdict: "new_right", date: "2026-09-08", reason: "too short" })))
      .toThrow(/reason/);
    const [c] = parseCorpus(
      adj({
        verdict: "harness",
        date: "2026-09-08",
        reason: "the seam it ran through had been deleted; restoring it restores the case",
      }),
    );
    expect(c.adjudication?.verdict).toBe("harness");
  });

  it("never mistakes a phone-shaped string in a message for real contact data", () => {
    // Wire-format @lid ids are legitimate case content (S28 Izzet/Elnur).
    const lid = {
      ...good,
      id: "S28-lid",
      sections: ["S28"],
      messages: [{ from: "najib", body: "@158055467598020 is replacing @189206211076115" }],
    };
    expect(parseCorpus(line(lid))).toHaveLength(1);
  });
});

describe("the real corpus file", () => {
  const cases = loadCorpus();

  it("loads and validates", () => {
    expect(cases.length).toBeGreaterThan(20);
  });

  it("every case cites a real provenance and says which kind it is", () => {
    for (const c of cases) {
      expect(["commit", "pr", "doc"], c.id).toContain(c.provenance.kind);
      // A commit- or PR-sourced case must name the ref it was
      // reconstructed from; a doc-sourced one must say so in its note.
      if (c.provenance.kind === "doc") {
        expect(c.provenance.note, c.id).toMatch(/doc|not reconstruct|unverified/i);
      } else {
        expect(c.provenance.ref, c.id).toBeTruthy();
      }
    }
  });

  it("every case carries at least one §3.2 section and a category", () => {
    for (const c of cases) {
      expect(c.sections.length, c.id).toBeGreaterThan(0);
      for (const s of c.sections) expect(ALL_PROMPT_SECTIONS, c.id).toContain(s);
    }
  });

  it("no case leaks a phone number in its world (real club members live here)", () => {
    const raw = JSON.stringify(cases);
    expect(raw).not.toMatch(/\+44\d{9,}/);
    expect(raw).not.toMatch(/@c\.us/);
  });

  it("is stored at the documented path", () => {
    expect(CORPUS_PATH).toMatch(/incidents\.jsonl$/);
  });
});
