/**
 * §10 STEP 7 PART 2 — THE ENGINE, ON THE TWO ROUTES THAT WRITE.
 *
 * `score` and `admin_ops` were held back from part 1 for reasons
 * `answer-batch.ts`'s header states precisely: a score is a write
 * against a finished match with the Elo deltas behind it, and an admin
 * op is real money on a live club plus a time phrase that nothing
 * resolved. Everything below is those reasons, discharged one at a time.
 *
 * A separate file from `engine.test.ts` on purpose: these are the rules
 * a revert of `SCORE_ENGINE_ENABLED` or `ADMIN_OPS_ENGINE_ENABLED` would
 * be reverting, and keeping them together makes "what does this flag
 * actually decide?" one file rather than a grep.
 */
import { describe, it, expect } from "vitest";
import { decide } from "../engine";
import { NOW, msg, world } from "./helpers";

describe("S17 · a score from an UNRESOLVED sender is still recorded", () => {
  // `route.ts:3457-3462` in its own words: "If we CAN'T resolve them
  // (e.g. WhatsApp hid the phone via @lid and the pushname didn't match
  // any player) → still write the score, because … losing the score
  // entirely is a worse failure mode than occasionally trusting a wrong
  // number." Since the @lid change an unresolved sender is ROUTINE
  // rather than exotic, so this covers most of a real group's reports.
  const played = () =>
    world({
      confirmed: ["kemal", "elvin"],
      completedMatch: { id: "done-1", participantUserIds: ["u-kemal", "u-elvin"] },
    });

  it("records the result, and says why it accepted an unknown sender", () => {
    const r = decide({
      now: NOW,
      state: played(),
      messages: [
        msg({
          from: null,
          body: "we won 5-3",
          route: "score",
          facts: { kind: "score", first: 5, second: 3 },
        }),
      ],
    });
    expect(r.writes.find((w) => w.kind === "score")).toMatchObject({ red: 5, yellow: 3 });
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/unresolved sender/i);
  });

  it("still refuses a RESOLVED member who neither played nor is an admin", () => {
    // The §9 authorisation seatbelt is untouched. The widening is about
    // "WhatsApp did not tell us who this is", never about "we know who
    // this is and they may not".
    const r = decide({
      now: NOW,
      state: played(),
      messages: [
        msg({
          from: "zair",
          body: "we won 9-0",
          route: "score",
          facts: { kind: "score", first: 9, second: 0 },
        }),
      ],
    });
    expect(r.writes).toHaveLength(0);
  });

  it("an unresolved sender cannot overwrite a result already recorded", () => {
    const r = decide({
      now: NOW,
      state: world({
        confirmed: ["kemal"],
        completedMatch: { id: "done-1", redScore: 5, yellowScore: 2, participantUserIds: [] },
      }),
      messages: [
        msg({
          from: null,
          body: "nah it was 9-0",
          route: "score",
          facts: { kind: "score", first: 9, second: 0 },
        }),
      ],
    });
    expect(r.writes).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/already recorded/i);
  });

  it("records a score on a match still sitting at TEAMS_PUBLISHED", () => {
    // The status the shipped path accepts and the old loader could not
    // produce. A match only becomes COMPLETED when somebody records a
    // score, so this shape IS the first score of every match.
    const r = decide({
      now: NOW,
      state: world({
        confirmed: ["kemal"],
        completedMatch: {
          id: "done-1",
          status: "TEAMS_PUBLISHED",
          participantUserIds: ["u-kemal"],
        },
      }),
      messages: [
        msg({
          from: "kemal",
          body: "4-4",
          route: "score",
          facts: { kind: "score", first: 4, second: 4 },
        }),
      ],
    });
    expect(r.writes.find((w) => w.kind === "score")).toMatchObject({ red: 4, yellow: 4 });
    expect(r.nextState.completedMatch?.status).toBe("COMPLETED");
  });
});

describe("S22 · the reminder time is resolved by code, never by the model", () => {
  const ask = (phrase: string, over: Parameters<typeof world>[0] = {}) =>
    decide({
      // Tue 1 Sep 2026, 19:00 London (18:00Z, BST).
      now: NOW,
      state: world({ confirmed: ["kemal"], ...over }),
      messages: [
        msg({
          from: "zair",
          body: `@Match Time remind me ${phrase}`,
          tagged: true,
          route: "admin_ops",
          facts: { kind: "admin", action: "reminder", phrase },
        }),
      ],
    });

  it("turns the phrase into an instant and a label", () => {
    const r = ask("tomorrow at 6");
    const w = r.writes.find((x) => x.kind === "reminder");
    expect(w).toBeTruthy();
    if (w?.kind === "reminder") {
      expect(w.sendAt.toISOString()).toBe("2026-09-02T17:00:00.000Z"); // 18:00 BST
      expect(w.whenLabel).toBe("Wed 2 Sep at 18:00");
      expect(w.phrase).toBe("tomorrow at 6");
    }
  });

  it("acknowledges with the RESOLVED time, not the words asked", () => {
    const s = ask("tomorrow at 6").speech.find((x) => x.kind === "reminder_ack");
    expect(s).toMatchObject({ whenLabel: "Wed 2 Sep at 18:00" });
  });

  it("refuses a phrase the resolver cannot read, and says so", () => {
    const r = ask("before the match");
    expect(r.writes).toHaveLength(0);
    expect(r.degradations.some((d) => /could not be resolved/i.test(d.detail))).toBe(true);
  });

  it("refuses anything outside the shipped 60-day window", () => {
    const r = ask("in 80 days");
    expect(r.writes).toHaveLength(0);
    expect(r.degradations.some((d) => /60-day/i.test(d.detail))).toBe(true);
  });

  it("stays silent for an org that has reminders switched off", () => {
    const r = ask("tomorrow", { features: { reminders: false } });
    expect(r.writes).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/reminders are off/i);
  });

  it("degrades for a member with no phone number on file", () => {
    // Nowhere to send it. The shipped path answers in the group; this
    // hands the message back so the player reads that shipped sentence
    // rather than a second wording of it.
    const r = ask("tomorrow", { noPhone: ["zair"] });
    expect(r.writes).toHaveLength(0);
    expect(r.degradations.some((d) => /no phone/i.test(d.detail))).toBe(true);
  });

  it("requires the @Match Time tag, exactly as the contract does", () => {
    const r = decide({
      now: NOW,
      state: world({ confirmed: ["kemal"] }),
      messages: [
        msg({
          from: "zair",
          body: "remind me tomorrow",
          tagged: false,
          route: "admin_ops",
          facts: { kind: "admin", action: "reminder", phrase: "tomorrow" },
        }),
      ],
    });
    expect(r.writes).toHaveLength(0);
  });
});

describe("S21 · the covered list, when the money names people", () => {
  const credit = (coveredRefs: string[] | undefined, from = "elvin") =>
    decide({
      now: NOW,
      state: world({
        confirmed: ["kemal", "elvin", "sait", "amir"],
        features: { paymentTracking: true },
        completedMatch: {
          id: "done-1",
          participantUserIds: ["u-kemal", "u-elvin", "u-sait", "u-amir"],
        },
      }),
      messages: [
        msg({
          from,
          body: "@Match Time Amir paid",
          tagged: true,
          route: "admin_ops",
          facts: {
            kind: "admin",
            action: "bulk_payment",
            payerRef: "Amir",
            count: 2,
            ...(coveredRefs ? { coveredRefs } : {}),
          },
        }),
      ],
    });

  it("a bare count is an AGGREGATE credit", () => {
    const w = credit(undefined).writes.find((x) => x.kind === "payment_credit");
    expect(w).toMatchObject({ namedCovered: false, coveredUserIds: [] });
  });

  it("named players are a NAMED credit, which is a different write", () => {
    const w = credit(["Sait", "Kemal"]).writes.find((x) => x.kind === "payment_credit");
    expect(w).toMatchObject({ namedCovered: true });
    if (w?.kind === "payment_credit") {
      expect([...w.coveredUserIds].sort()).toEqual(["u-kemal", "u-sait"]);
    }
  });

  it('"me" is the sender, resolved from a closed list and not by a model', () => {
    const w = credit(["me", "Sait"]).writes.find((x) => x.kind === "payment_credit");
    if (w?.kind === "payment_credit") {
      expect([...w.coveredUserIds].sort()).toEqual(["u-elvin", "u-sait"]);
      expect(w.namedCovered).toBe(true);
    }
  });

  it("keeps the names it could resolve and reports the ones it could not", () => {
    const r = credit(["Sait", "Bartholomew"]);
    const w = r.writes.find((x) => x.kind === "payment_credit");
    if (w?.kind === "payment_credit") expect(w.coveredUserIds).toEqual(["u-sait"]);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/Bartholomew/);
  });

  it("refuses outright when it names people and NONE of them resolve", () => {
    // The shipped path credits nothing here and then announces that it
    // did (`route.ts:3841-3886`, then `:3910`). Falling through to the
    // aggregate branch would be worse still — a number credited for
    // people nobody could identify. Neither: hand it back.
    const r = credit(["Bartholomew", "Cuthbert"]);
    expect(r.writes).toHaveLength(0);
    expect(r.degradations.some((d) => /none of them resolve/i.test(d.detail))).toBe(true);
  });
});

describe("the recruit blast is DECIDED by the engine and RUN by the route", () => {
  const recruit = (from: string, lookbackMatches?: number, tagged = true) =>
    decide({
      now: NOW,
      state: world({ confirmed: ["kemal", "elvin", "sait"] }),
      messages: [
        msg({
          from,
          tagged,
          body: "@Match Time message everyone from the last 5 games and invite them",
          route: "admin_ops",
          facts: {
            kind: "admin",
            action: "recruit",
            ...(lookbackMatches === undefined ? {} : { lookbackMatches }),
          },
        }),
      ],
    });

  it("an admin's ask proposes a blast, with no lookback when none was stated", () => {
    const w = recruit("kemal").writes.find((x) => x.kind === "recruit_blast");
    expect(w).toMatchObject({ lookbackMatches: null });
  });

  it("carries a stated lookback through", () => {
    const w = recruit("kemal", 5).writes.find((x) => x.kind === "recruit_blast");
    expect(w).toMatchObject({ lookbackMatches: 5 });
  });

  it("CLAMPS a number the model read out of a sentence", () => {
    // A mass DM from an unofficial WhatsApp client is how the account
    // gets banned, which takes the whole product down. "the last 50
    // games" must never reach `inviteRecentPlayers` as 50.
    const r = recruit("kemal", 50);
    const w = r.writes.find((x) => x.kind === "recruit_blast");
    expect(w).toMatchObject({ lookbackMatches: 12 });
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/clamped to 12/);
  });

  it("refuses a non-admin", () => {
    const r = recruit("zair");
    expect(r.writes).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/only an admin/i);
  });

  it("does not need a tag from an admin (PR #33)", () => {
    const w = recruit("kemal", undefined, false).writes.find((x) => x.kind === "recruit_blast");
    expect(w).toBeTruthy();
  });

  it("proposes no speech of its own — the route speaks after the blast runs", () => {
    // 2026-09-01: the blast ran FIRST, counted a squad the same message
    // was about to change, and told the owner it was full one line after
    // he said Najib was out. The engine models the DECISION only; the
    // words come from what `inviteRecentPlayers` actually did.
    const r = recruit("kemal");
    expect(r.speech).toHaveLength(0);
  });
});
