/**
 * The pasted-roster defect, reproduced DETERMINISTICALLY.
 *
 * PR #35's self-replay sweep ran the current analyzer against itself:
 * same message, same reconstructed world, same model, twice. Three of
 * its four write-level disagreements were one message shape — a pasted
 * numbered roster. The 2026-06-07 batch
 * (`g-ab95248799:2026-06-07T17:35:23.730Z`, triage card in
 * `.e2e/replay/<runId>/triage.md`) came back as:
 *
 *   run A  →  Mo, Nabeel
 *   run B  →  Adam, Amir, Ehtisham Ul Haq, Martin, Mo
 *
 * from the SAME two messages against the SAME 0/14 squad. Neither run
 * wrote the union. A player's place in a squad decided by luck.
 *
 * A live replay costs money and is, by definition, not reproducible on
 * demand. So this spec does the thing the live sweep cannot: it feeds
 * the route BOTH of the model readings that were actually observed, on
 * the identical real input, through the stub seam — and asserts the
 * database ends up in the same place either way. That turns model
 * non-determinism into a deterministic, free, repeatable test.
 *
 * ── PORTED 2026-09-06, §10 STEP 8 ───────────────────────────────────
 *
 * The two readings were `AnalysisVerdict`s; they are now two sets of
 * EXTRACTOR FACTS, which is the same disagreement one layer down: run A
 * found one third-party claim off the list, run B found four. Nothing
 * about the input, the world or the expected end state changed.
 *
 * The guard did not move either. `reconcilePastedRoster` runs in
 * `analyze/route.ts` BEFORE the engine and
 * `attendance-engine-batch.ts` refuses any message `parsePastedRoster`
 * recognises, so a paste is decided by arithmetic over the list and the
 * roster post, never by whoever read it. That is why both readings land
 * in the same place: neither of them is consulted.
 *
 * Before the clamp it fails: the two runs leave different squads.
 * After it, both leave the squad untouched, because a re-paste is a
 * restatement of a list and not a registration event. Groups that
 * really do maintain their squad by re-pasting have
 * `lib/squad-from-list.ts` behind `featureSquadFromList`, which keeps
 * the previous list and can diff it; this route cannot and must not
 * guess.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { claim, engineOn, facts, otherClaim, selfIn, type BodyRouting } from "../helpers/stub";
import { U, PHONE, MATCH } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

/** The real message Adam Khandaza posted at 17:35 on 2026-06-07 — the
 *  seed list, five names. Word joiners (U+2060) are the ones WhatsApp
 *  leaves behind on a copy-paste, kept verbatim. */
const ADAM_PASTE = `In sha Allah 9pm Thursday 11 June Wimbledon Goals 7 a side football:

1. Ehtisham
2. Amir
3. ⁠Martin
4. Adam
5. Mo`;

/** Nabeel's re-paste seconds later — the same list with his own line
 *  appended. This is the ritual: copy, append, re-post. */
const NABEEL_PASTE = `${ADAM_PASTE}
6. ⁠ NABEEL`;

/** What the pipeline read on run A. Adam's paste came back with nothing
 *  in it; Nabeel's found his own IN plus "Mo" picked off the list. */
const RUN_A: [BodyRouting, BodyRouting] = [
  { route: "none" },
  {
    route: "self_att",
    facts: facts([claim(), otherClaim("Mo", "in")]),
  },
];

/** What it read on run B, on byte-identical input. Adam's paste found
 *  Adam plus four names off the list; Nabeel's — the one that actually
 *  added a name — came back with nothing. */
const RUN_B: [BodyRouting, BodyRouting] = [
  {
    route: "other_att",
    facts: facts([
      claim(),
      otherClaim("Ehtisham", "in"),
      otherClaim("Amir", "in"),
      otherClaim("Martin", "in"),
      otherClaim("Mo", "in"),
    ]),
  },
  { route: "none" },
];

let n = 0;
const msgId = () => `e2e-roster-${Date.now()}-${++n}`;

interface Row {
  name: string;
  status: string;
}

/** Everyone with an attendance row on the upcoming match, by name. The
 *  squad as a set — the only thing §10 step 3 turns on. */
async function squad(db: TestDb): Promise<string[]> {
  const rows = await db.all<Row>(
    `SELECT u.name AS name, a.status AS status
       FROM "Attendance" a JOIN "User" u ON u.id = a."userId"
      WHERE a."matchId" = $1
      ORDER BY u.name`,
    [MATCH.upcoming],
  );
  return rows.map((r) => `${r.name}:${r.status}`);
}

/** Members of the e2e org, by name — a registerFor for an unknown name
 *  PROVISIONS one, which is the most expensive form of over-registering
 *  (a ghost player nobody can contact). */
async function members(db: TestDb): Promise<string[]> {
  const rows = await db.all<{ name: string }>(
    `SELECT u.name AS name FROM "Membership" m JOIN "User" u ON u.id = m."userId"
      WHERE m."orgId" = $1 AND m."leftAt" IS NULL ORDER BY u.name`,
    ["e2e-org"],
  );
  return rows.map((r) => r.name);
}

/**
 * Reset to the fixture world, rename two unregistered seed users to the
 * real senders, replay the batch with the given model output, and read
 * back the squad. The rename is what lets the REAL message be posted by
 * senders the route can actually resolve — "Adam" and "NABEEL" are
 * slots in the list, so the self-registration half of the clamp is
 * exercised too.
 */
async function replay(
  request: Parameters<typeof postAnalyze>[0],
  db: TestDb,
  readings: [BodyRouting, BodyRouting],
): Promise<{ squad: string[]; members: string[] }> {
  resetDb();
  await db.run(`UPDATE "User" SET name = 'Adam Khandaza' WHERE id = $1`, [U.fresh]);
  await db.run(`UPDATE "User" SET name = 'Nabeel' WHERE id = $1`, [U.extra]);

  const a = msgId();
  const b = msgId();
  engineOn({ [ADAM_PASTE]: readings[0], [NABEEL_PASTE]: readings[1] });
  await postAnalyze(request, [
    { waMessageId: a, body: ADAM_PASTE, authorPhone: PHONE.fresh, authorName: "Adam Khandaza" },
    { waMessageId: b, body: NABEEL_PASTE, authorPhone: PHONE.extra, authorName: "Nabeel" },
  ]);
  return { squad: await squad(db), members: await members(db) };
}

test("the same pasted roster leaves the SAME squad whichever way the model reads it", async ({
  request,
  db,
}) => {
  const a = await replay(request, db, RUN_A);
  const b = await replay(request, db, RUN_B);

  // THE DEFECT. Before the clamp: A leaves Nabeel + a provisioned "Mo";
  // B leaves Adam Khandaza + provisioned Amir, Ehtisham, Martin, Mo.
  expect(b.squad, "the same message must not produce two different squads").toEqual(a.squad);
  expect(b.members, "the same message must not provision two different member sets").toEqual(
    a.members,
  );
});

test("neither reading registers anyone — a re-paste is a restatement, not a registration", async ({
  request,
  db,
}) => {
  resetDb();
  const baseline = { squad: await squad(db), members: await members(db) };

  const a = await replay(request, db, RUN_A);
  expect(a.squad).toEqual(baseline.squad);
  // The rename is the only membership difference; nobody NEW was
  // provisioned off the list.
  expect(a.members).toHaveLength(baseline.members.length);
  expect(a.members).not.toContain("Mo");

  const b = await replay(request, db, RUN_B);
  expect(b.squad).toEqual(baseline.squad);
  expect(b.members).toHaveLength(baseline.members.length);
  for (const ghost of ["Amir", "Ehtisham", "Martin", "Mo"]) {
    expect(b.members, `${ghost} must not be provisioned off a pasted list`).not.toContain(ghost);
  }
});

/* ══════════════════════════════════════════════════════════════════════
 * INVERTED 2026-09-06 (§10 STEP 8). THIS IS AN ACCEPTED, DOCUMENTED LOSS.
 * ══════════════════════════════════════════════════════════════════════
 *
 * WAS: "a real add ALONGSIDE a paste still registers — the clamp is not a
 * mute button". `clampRosterDerivedWrites` removed only the names the
 * LIST mentions, so "also adding Ian Innes" travelling beside a paste
 * still registered Ian.
 *
 * `analyze/route.ts`'s pasted-roster section states the change in terms:
 * the peel "loses only the residue — names the model found that the LIST
 * does not mention, i.e. prose travelling alongside a paste ('here's the
 * list, also adding Kieran'). Kieran now needs one more message, which is
 * §13's stated trade: a missed add is recoverable in one message." The
 * whole message is claimed by `reconcilePastedRoster`, which computes the
 * new lines from the list and the roster post and never consults an
 * extractor at all.
 *
 * So the test is INVERTED rather than deleted: the loss is written down
 * as a passing assertion, where a club can be told about it and where
 * restoring the behaviour would show up as a failure asking whether the
 * trade was reconsidered on purpose.
 */
test("a real add alongside a paste is LOST — the accepted cost of the paste peel", async ({
  request,
  db,
}) => {
  resetDb();
  const id = msgId();
  const body = `${ADAM_PASTE}\n\nalso adding Ian Innes, he messaged me`;
  // Perfectly good facts, and they are never consulted: "Amir" is a slot
  // in the list, "Ian Innes" is named only in the prose.
  engineOn({
    [body]: {
      route: "other_att",
      facts: facts([otherClaim("Amir", "in"), otherClaim("Ian Innes", "in")]),
    },
  });
  await postAnalyze(request, [
    {
      waMessageId: id,
      body,
      authorPhone: PHONE.admin,
      authorName: "Alex Admin",
    },
  ]);

  const s = await squad(db);
  expect(
    s.some((r) => r.startsWith("Ian Innes:")),
    "the prose add is lost with the rest of the residue; Ian needs one more message",
  ).toBe(false);
  // The half that has not changed, and is the more expensive direction:
  // nobody off the LIST is registered or provisioned either.
  expect(s.some((r) => r.startsWith("Amir:"))).toBe(false);
  expect(await members(db)).not.toContain("Amir");
});

/** The seeded upcoming match confirms Alex, Colin, Pat and Tom in that
 *  order (Ben is on the bench). A forward of MatchTime's own roster post
 *  restates exactly that prefix and fills slot 5 — the S26 shape. */
const OF_RECORD_PASTE =
  "1. Alex Admin\n2. Colin Collector\n3. Pat Player\n4. Tom Third\n5. Ian Innes";

test("an OF-RECORD paste registers the appended name — and the same one either way", async ({
  request,
  db,
}) => {
  // Two readings of the identical message. The model's own picks off
  // the list are discarded and recomputed from the squad, so it does
  // not matter which of these it produced.
  const readings: BodyRouting[] = [
    { route: "none" },
    {
      route: "other_att",
      // over-reads the list: re-registers two confirmed players and
      // misses nothing only by accident
      facts: facts([
        otherClaim("Alex Admin", "in"),
        otherClaim("Colin Collector", "in"),
        otherClaim("Ian Innes", "in"),
      ]),
    },
  ];

  const outcomes: string[][] = [];
  for (const reading of readings) {
    resetDb();
    const id = msgId();
    engineOn({ [OF_RECORD_PASTE]: reading });
    await postAnalyze(request, [
      {
        waMessageId: id,
        body: OF_RECORD_PASTE,
        authorPhone: PHONE.admin,
        authorName: "Alex Admin",
      },
    ]);
    outcomes.push(await squad(db));
  }

  expect(outcomes[1]).toEqual(outcomes[0]);
  expect(outcomes[0]).toContain("Ian Innes:CONFIRMED");
  // …and nobody who was already confirmed was touched or duplicated.
  expect(outcomes[0].filter((r) => r.startsWith("Alex Admin:"))).toHaveLength(1);
});

test("the sender appending their OWN name registers them, not a third party", async ({
  request,
  db,
}) => {
  resetDb();
  const id = msgId();
  engineOn({ [OF_RECORD_PASTE]: { route: "none" } });
  await postAnalyze(request, [
    {
      waMessageId: id,
      body: OF_RECORD_PASTE,
      authorPhone: PHONE.fresh,
      authorName: "Ian Innes",
    },
  ]);
  expect(await squad(db)).toContain("Ian Innes:CONFIRMED");
});

/* ══════════════════════════════════════════════════════════════════════
 * KNOWN DEFECT, FOUND BY THIS PORT (2026-09-06). NOT A WEAKENED TEST.
 * ══════════════════════════════════════════════════════════════════════
 *
 * `test.fail()` says "this must currently fail". The assertions below are
 * the CORRECT behaviour and are unchanged from the version that passed
 * before §10 step 8. When it is fixed this test starts failing for the
 * opposite reason ("expected to fail but passed"), which is the tripwire
 * telling whoever fixed it to delete this block.
 *
 * THE DEFECT. `analyze/route.ts`'s pasted-roster section calls
 * `decidePastedRosterRegistration` on every message and, for ANY message
 * it calls a roster — of record or not — does `statsRequestIds.add(...)`
 * and `continue`s. That short-circuit peels the WHOLE message off the
 * batch, so the sender's own OUT, sitting in the same message as the
 * paste, is never extracted, never decided and never written. Pat says
 * "can't make it lads, someone take my spot", pastes the list, and stays
 * down as playing.
 *
 * The old `clampRosterDerivedWrites` could not do this: it removed
 * ADDITIONS the list mentioned and left everything else on the verdict,
 * which is exactly what this test's original title says — "the clamp
 * never eats a drop".
 *
 * WHY IT IS NOT THE SAME AS THE ACCEPTED LOSS ABOVE. That one is a
 * missed ADD, and `route.ts` cites §13 in terms: "a missed add is
 * recoverable in one message". A missed DROP is the other direction —
 * the squad reads full, the slot is never offered to the bench, and the
 * club is a player short on the night. §13's own asymmetry argues
 * against it rather than for it, and the route's comment does not claim
 * this case at all.
 *
 * IT IS ALSO THE THIRD INSTANCE OF ONE BUG CLASS. `MEMORY.md`'s
 * "terminal short-circuits skip every guard below" records three
 * incidents in two days from the same shape in this same file: a
 * `continue` that silently deletes everything beneath it. This is a
 * fourth, introduced where the paste handling moved above the engine.
 *
 * WHY IT IS NOT FIXED IN THIS PR. The fix is in
 * `src/app/api/whatsapp/analyze/route.ts` — peel the paste's
 * REGISTRATIONS without peeling the message — and this PR is a test
 * migration with another change in flight in the same area. Written up
 * in the PR body.
 * ══════════════════════════════════════════════════════════════════════ */
test("the peel never eats a drop — an OUT beside a paste still fires", async ({
  request,
  db,
}) => {
  test.fail();
  resetDb();
  const before = await db.one<{ status: string }>(
    `SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.upcoming, U.player],
  );
  expect(before?.status).toBe("CONFIRMED");

  const id = msgId();
  const body = `can't make it lads, someone take my spot\n${ADAM_PASTE}`;
  engineOn({ [body]: { route: "self_att", facts: selfIn({ polarity: "out" }) } });
  // Pat pastes the list AND says he is out. The peel only ever removes
  // additions, so the OUT survives even though "Pat" is not a slot.
  await postAnalyze(request, [
    {
      waMessageId: id,
      body,
      authorPhone: PHONE.player,
      authorName: "Pat Player",
    },
  ]);

  const after = await db.one<{ status: string }>(
    `SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.upcoming, U.player],
  );
  expect(after?.status).toBe("DROPPED");
});
