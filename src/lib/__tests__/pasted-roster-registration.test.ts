/**
 * RED FIRST. The model-free pasted-roster registration decision.
 *
 * The fixtures are the ones already in `pasted-roster.test.ts` — the S26
 * forwarded-roster shape (`4cbdd05`, 2026-04-24) and the real 2026-06-11
 * Thursday-group paste that the PR #35 self-replay sweep proved the
 * incumbent could not reproduce. Nothing here is invented.
 */
import { describe, it, expect } from "vitest";
import { decidePastedRosterRegistration } from "../pasted-roster-registration";

/** S26: the confirmed squad, in Match Context order — exactly what
 *  MatchTime's own roster post lists, which is what an of-record paste
 *  is a forward of. */
const S26_CONFIRMED = [
  "Kemal Ediz",
  "Elvin Aliyev",
  "Sait Demir",
  "Mustafa Kaya",
  "Abid Hussain",
  "Idris Bello",
  "Faris Nasser",
  "Shaz Iqbal",
  "Adam Osman",
  "Efat Rahman",
  "Usama Tariq",
  "Karahan Yildiz",
];

const numbered = (names: string[]) => names.map((n, i) => `${i + 1}. ${n}`).join("\n");

/** The squad restated in order with two names appended. */
const S26_PASTE_TWO_APPENDED = `${numbered(S26_CONFIRMED)}
13. Zair Malik
14. Wasim Akhtar`;

/** The real 2026-06-11 paste (Youssef). Word-joiners, shouted NABEEL,
 *  the "Yusuf.i" handle and a duplicated Adam all survive the copy. */
const REAL_20260611 = `In sha Allah 9pm Thursday 11 June Wimbledon Goals 7 a side football:

1. Ehtisham
2. Amir
3. ⁠Martin
4. Adam
5. Mo
6. ⁠ NABEEL
7. ⁠Talha
8. ⁠Yusuf.i
9. ⁠Amz
10. Youssef
11. ⁠Ersin
12. ⁠Omar
13. ⁠Adam
14. Arjun`;

describe("decidePastedRosterRegistration — of record", () => {
  it("registers EXACTLY the two appended names, computed from the squad", () => {
    const d = decidePastedRosterRegistration({
      body: S26_PASTE_TWO_APPENDED,
      confirmedNames: S26_CONFIRMED,
      senderNames: ["Kemal Ediz", "Kemal"],
    });
    expect(d.kind).toBe("of_record");
    expect(d.additions).toEqual(["Zair Malik", "Wasim Akhtar"]);
    // The sender is already IN (slot 1), so they are not an addition.
    expect(d.senderAddition).toBeNull();
  });

  it("splits the sender's OWN appended name out of the third-party list", () => {
    const d = decidePastedRosterRegistration({
      body: S26_PASTE_TWO_APPENDED,
      confirmedNames: S26_CONFIRMED,
      senderNames: ["Wasim Akhtar", "Wasim"],
    });
    expect(d.kind).toBe("of_record");
    expect(d.additions).toEqual(["Zair Malik", "Wasim Akhtar"]);
    expect(d.senderAddition).toBe("Wasim Akhtar");
    // The caller registers `additions` minus `senderAddition` for others
    // and turns the sender's own name into registerAttendance: "IN".
    expect(d.additions.filter((n) => n !== d.senderAddition)).toEqual(["Zair Malik"]);
  });

  it("matches a first name in the list against the fuller member record", () => {
    const d = decidePastedRosterRegistration({
      body: "1. Kemal\n2. Elvin\n3. Sait\n4. Mustafa\n5. Zair Malik",
      confirmedNames: S26_CONFIRMED.slice(0, 4),
      senderNames: ["Zair Malik"],
    });
    expect(d.kind).toBe("of_record");
    expect(d.additions).toEqual(["Zair Malik"]);
    expect(d.senderAddition).toBe("Zair Malik");
  });

  it("a straight re-listing with nothing appended registers nobody", () => {
    const d = decidePastedRosterRegistration({
      body: numbered(S26_CONFIRMED),
      confirmedNames: S26_CONFIRMED,
      senderNames: ["Kemal Ediz"],
    });
    expect(d.kind).toBe("of_record");
    expect(d.additions).toEqual([]);
    expect(d.senderAddition).toBeNull();
  });

  it("a null / empty sender name never claims an addition", () => {
    const d = decidePastedRosterRegistration({
      body: S26_PASTE_TWO_APPENDED,
      confirmedNames: S26_CONFIRMED,
      senderNames: [null, null],
    });
    expect(d.kind).toBe("of_record");
    expect(d.senderAddition).toBeNull();
  });
});

describe("decidePastedRosterRegistration — not of record", () => {
  it("the group's OWN ritual order registers nobody", () => {
    // The squad runs Ehtisham, Amir, Nabeel…; the paste runs Ehtisham,
    // Amir, Martin…. Slot 3 settles it — this is a list somebody typed,
    // not a forward of MatchTime's post.
    const d = decidePastedRosterRegistration({
      body: REAL_20260611,
      confirmedNames: ["Ehtisham", "Amir", "Nabeel", "Adam", "Mo"],
      senderNames: ["Youssef"],
    });
    expect(d.kind).toBe("not_of_record");
    expect(d.additions).toEqual([]);
    expect(d.senderAddition).toBeNull();
    expect(d.reason).toBe("prefix-mismatch");
  });

  it("a paste SHORTER than the confirmed squad registers nobody", () => {
    const d = decidePastedRosterRegistration({
      body: numbered(S26_CONFIRMED.slice(0, 5)),
      confirmedNames: S26_CONFIRMED,
      senderNames: ["Kemal Ediz"],
    });
    expect(d.kind).toBe("not_of_record");
    expect(d.additions).toEqual([]);
    expect(d.reason).toBe("prefix-mismatch");
  });

  it("a list against an EMPTY squad registers nobody", () => {
    const d = decidePastedRosterRegistration({
      body: REAL_20260611,
      confirmedNames: [],
      senderNames: ["Youssef"],
    });
    expect(d.kind).toBe("not_of_record");
    expect(d.additions).toEqual([]);
    expect(d.reason).toBe("no-confirmed-squad");
  });

  it("a blank slot inside the restated prefix breaks the match", () => {
    const body = `1. ${S26_CONFIRMED[0]}\n2.\n3. ${S26_CONFIRMED[2]}\n4. ${S26_CONFIRMED[3]}\n5. Zair Malik`;
    const d = decidePastedRosterRegistration({
      body,
      confirmedNames: S26_CONFIRMED.slice(0, 4),
      senderNames: ["Zair Malik"],
    });
    expect(d.kind).toBe("not_of_record");
    expect(d.additions).toEqual([]);
  });
});

describe("decidePastedRosterRegistration — not a roster", () => {
  const NOT_ROSTERS: Array<[string, string]> = [
    ["I'm in for Thursday", "plain prose"],
    ["", "empty"],
    ["1. Ehtisham\n2. Amir\n3. Martin", "three lines is a paragraph, not a list"],
    ["also adding Kieran and Rashad please", "prose naming two people"],
  ];
  for (const [body, why] of NOT_ROSTERS) {
    it(`returns not_a_roster for "${body.slice(0, 30)}" (${why})`, () => {
      const d = decidePastedRosterRegistration({
        body,
        confirmedNames: S26_CONFIRMED,
        senderNames: ["Kemal Ediz"],
      });
      expect(d.kind).toBe("not_a_roster");
      expect(d.additions).toEqual([]);
      expect(d.senderAddition).toBeNull();
      expect(d.reason).toBe("not-a-roster");
    });
  }
});

describe("decidePastedRosterRegistration — properties that must hold", () => {
  it("is pure: the same inputs give the same decision", () => {
    const args = {
      body: S26_PASTE_TWO_APPENDED,
      confirmedNames: S26_CONFIRMED,
      senderNames: ["Wasim Akhtar"],
    };
    expect(decidePastedRosterRegistration(args)).toEqual(
      decidePastedRosterRegistration(args),
    );
  });

  it("never registers anybody the paste does not name", () => {
    const d = decidePastedRosterRegistration({
      body: S26_PASTE_TWO_APPENDED,
      confirmedNames: S26_CONFIRMED,
      senderNames: ["Kemal Ediz"],
    });
    for (const n of d.additions) {
      expect(S26_PASTE_TWO_APPENDED).toContain(n);
    }
  });

  it("never re-registers a name that is already confirmed", () => {
    const body = `${numbered(S26_CONFIRMED)}\n13. Kemal Ediz\n14. Zair Malik`;
    const d = decidePastedRosterRegistration({
      body,
      confirmedNames: S26_CONFIRMED,
      senderNames: ["Kemal Ediz"],
    });
    expect(d.kind).toBe("of_record");
    expect(d.additions).toEqual(["Zair Malik"]);
  });
});
