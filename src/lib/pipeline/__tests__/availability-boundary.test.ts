/**
 * The availability / standing-offer boundary, and why it is drawn at the
 * VERB.
 *
 * ── the defect (dry run, 2026-09-05, live model, 6 runs per row) ──────
 *
 *   | message                              | basis            | writes   |
 *   |--------------------------------------|------------------|----------|
 *   | "I'm around if you're short"         | availability 6/6 | no       |
 *   | "I'm free Tuesday if you need me"    | availability 4/6 | 3 of 12  |
 *   |                                      | decision     2/6 | UNSTABLE |
 *   | "put me down if you're short"        | decision 6/6     | yes      |
 *   | "count me as the 14th if you need one"| decision 6/6    | yes      |
 *
 * Both ends are stable. Only the ambiguous middle wobbles, and it
 * wobbles across the one field the engine reads to decide whether a
 * contingent self-claim registers the sender (`engine.ts`: an
 * `availability` claim that is not an OUT writes nothing; a contingent
 * SENDER claim conditioned on the squad is a standing offer and
 * registers — §3.2 S15(a), incident A5).
 *
 * ── why more examples were not the fix ───────────────────────────────
 * The prompt ALREADY carried "I'm around if you need me" in its
 * availability list, and the near-identical "I'm free Tuesday if you
 * need me" still flipped a quarter of the time. Listing a third
 * paraphrase would have been the same non-fix again. The RULE had to
 * become decisive, so it is now a mechanical test on the verb:
 *
 *   • the verb acts on the PERSON ("I'm free", "I'm around",
 *     "I'm available") → availability, and no place is asked for;
 *   • the verb acts on the SQUAD ("put me down", "count me in",
 *     "add me", "I'll take a spot") → decision.
 *
 * ── the decision this encodes (Kemal, 2026-09-05) ────────────────────
 * "I'm free Tuesday if you need me" must NOT register the sender. A real
 * player complained on 1 Sept, verbatim: "I can't come. Matchtime put my
 * name down as reserve without my confirm." Being put down without
 * asking is the failure mode being protected against. Availability is
 * necessary and never sufficient.
 *
 * These tests pin the PROMPT — the thing we own. Whether the model then
 * obeys it is a live measurement: `e2e/corpus/incidents.jsonl` cases
 * `PR48-*`, and `scripts/dryrun-pipeline.ts ONLY=P1 REPEAT=15`.
 */
import { describe, it, expect } from "vitest";
import { EXTRACTOR_PROMPTS } from "../extractors";

const P = EXTRACTOR_PROMPTS.attendance;

/** The `basis` paragraph, from its label to the start of the next field. */
function basisSection(): string {
  const start = P.indexOf("  basis ");
  expect(start, "no `basis` field found in the attendance prompt").toBeGreaterThan(-1);
  const rest = P.slice(start + 8);
  const end = rest.search(/\n {2}\w+ {2,}/);
  return P.slice(start, end === -1 ? undefined : start + 8 + end);
}

describe("the basis rule is decided by the verb, not by the courtesy", () => {
  it("still names both values", () => {
    expect(P).toMatch(/\bbasis\b/);
    expect(P).toMatch(/"decision"/);
    expect(P).toMatch(/"availability"/);
  });

  it("states the test as a property of the VERB", () => {
    expect(
      basisSection(),
      "the boundary has to be stated as a rule about the verb, or it is just more examples",
    ).toMatch(/\bverb\b/i);
  });

  it("says outright that a trailing courtesy does not promote a state into a decision", () => {
    const s = basisSection();
    // "if you need me" / "if you're short" is the exact thing the model
    // was over-reading as an ask.
    expect(s).toMatch(/if you need me/i);
    expect(s).toMatch(/if you're short/i);
    expect(s).toMatch(/\b(courtesy|politeness|does not|never)\b/i);
  });

  it("adjudicates the four measured phrasings by name", () => {
    const s = basisSection();
    for (const phrase of [
      "I'm free Tuesday if you need me",
      "I'm around if you're short",
      "put me down if you're short",
      "count me as the 14th if you need one",
    ]) {
      expect(s, `the rule must settle "${phrase}" explicitly`).toContain(phrase);
    }
  });

  it("puts the ambiguous phrase on the availability side", () => {
    const s = basisSection();
    const line = s.split("\n").find((l) => l.includes("I'm free Tuesday if you need me"));
    expect(line).toBeTruthy();
    expect(line, "the ambiguous phrase must be adjudicated as availability").toMatch(
      /availability/i,
    );
    expect(line).not.toMatch(/→\s*decision/i);
  });

  it("puts the two place-asking phrasings on the decision side", () => {
    const s = basisSection();
    for (const phrase of ["put me down if you're short", "count me as the 14th if you need one"]) {
      const line = s.split("\n").find((l) => l.includes(phrase));
      expect(line, `"${phrase}" must be adjudicated in the rule`).toBeTruthy();
      expect(line, `"${phrase}" is an ask for a place — it must stay a decision`).toMatch(
        /decision/i,
      );
    }
  });

  it("keeps the corpus's own standing-offer wordings on the decision side", () => {
    // Regression guard in the losing direction. These three are live
    // corpus cases that MUST still register:
    //   S15   "consider me as the 14th whenever you have 13 players"
    //   PR26  "I'll be the 14th if you're short"
    //   PR27  "happy to fill in if you're short"
    // A rule written as "anything with an 'if' is availability" passes
    // the case above and silently loses all three.
    const s = basisSection();
    for (const wording of ["count me in", "the 14th", "fill in"]) {
      expect(s, `"${wording}" must be named as a place-asking verb`).toContain(wording);
    }
  });

  it("keeps PR #44's control pair intact", () => {
    // "I'm in for next Tuesday" registers; "I will be back Tuesday week"
    // does not. Both name a day, so a day-based rule separates neither.
    const s = basisSection();
    expect(s).toContain("I'm in");
    expect(s).toMatch(/back Tuesday week/i);
  });

  it("does not ask the model what SHOULD happen", () => {
    // §6.2: the extractor reports facts. A "do not register" instruction
    // here would be the decision leaking back into the model.
    const s = basisSection();
    expect(s).not.toMatch(/\bregister\b/i);
    expect(s).not.toMatch(/\bno write\b/i);
    expect(s).not.toMatch(/\bbench\b/i);
  });
});
