/**
 * SIGNAL 1, AGAINST A REAL DATABASE: a group message proves its sender
 * is in the group.
 *
 * `src/lib/__tests__/group-sighting.test.ts` pins the JUDGEMENT (which
 * senders count, the throttle predicate, the fact that the payload has
 * exactly one field in it). This spec pins the WIRING, which is the half
 * this repo has repeatedly found dead: four seatbelts were discovered
 * unreachable on 2026-08-31 and the unresolved-sender nudge was gated on
 * the very field its own failure mode destroys. A write that no request
 * ever reaches is not a write.
 *
 * So: does an ordinary POST to /api/whatsapp/analyze actually move
 * `Membership.lastSeenInGroupAt`, does it leave everybody else alone,
 * and — the one that matters most — does it leave the SWEEP's clock
 * exactly where it found it.
 *
 * Every message here routes to "none" (banter). Presence does not depend
 * on what was said, and using banter keeps this spec off attendance's
 * toes entirely.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { engineOn } from "../helpers/stub";
import { U, PHONE, NAME, ORG_ID } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

let n = 0;
const msgId = () => `e2e-sighting-${Date.now()}-${++n}`;

async function sighting(db: TestDb, userId: string): Promise<Date | null> {
  const row = await db.one<{ v: Date | null }>(
    `SELECT "lastSeenInGroupAt" AS v FROM "Membership" WHERE "userId" = $1 AND "orgId" = $2`,
    [userId, ORG_ID],
  );
  return row?.v ?? null;
}

async function leftAt(db: TestDb, userId: string): Promise<Date | null> {
  const row = await db.one<{ v: Date | null }>(
    `SELECT "leftAt" AS v FROM "Membership" WHERE "userId" = $1 AND "orgId" = $2`,
    [userId, ORG_ID],
  );
  return row?.v ?? null;
}

async function sweepClock(db: TestDb): Promise<Date | null> {
  const row = await db.one<{ v: Date | null }>(
    `SELECT "lastParticipantSweepAt" AS v FROM "Organisation" WHERE id = $1`,
    [ORG_ID],
  );
  return row?.v ?? null;
}

test.beforeAll(async () => {
  resetDb();
});

test.beforeEach(async ({ db }) => {
  // The world of production today: the sweep has never managed to write
  // a thing, so every sighting is NULL and the org's clock is NULL.
  await db.run(`UPDATE "Membership" SET "lastSeenInGroupAt" = NULL WHERE "orgId" = $1`, [ORG_ID]);
  await db.run(`UPDATE "Organisation" SET "lastParticipantSweepAt" = NULL WHERE id = $1`, [
    ORG_ID,
  ]);
});

test("RAIHAN: a member with a phone and no sighting earns one by posting", async ({
  request,
  db,
}) => {
  // Ian Innes is the fixture world's Raihan: a real member, phone on
  // file, who the dead sweep has never confirmed.
  expect(await sighting(db, U.fresh)).toBeNull();

  const body = "morning all";
  engineOn({ [body]: { route: "none" } });
  await postAnalyze(request, [
    {
      waMessageId: msgId(),
      body,
      authorPhone: PHONE.fresh.replace("+", ""),
      authorName: NAME.fresh,
    },
  ]);

  const seen = await sighting(db, U.fresh);
  expect(seen).not.toBeNull();
  // And nothing about his membership changed except that one column.
  expect(await leftAt(db, U.fresh)).toBeNull();
});

test("a member who did NOT post is untouched — never marked absent", async ({ request, db }) => {
  const body = "haha";
  engineOn({ [body]: { route: "none" } });
  await postAnalyze(request, [
    {
      waMessageId: msgId(),
      body,
      authorPhone: PHONE.player.replace("+", ""),
      authorName: NAME.player,
    },
  ]);

  expect(await sighting(db, U.player)).not.toBeNull(); // the poster
  // Riley Rater said nothing. Absence is not provable, so silence must
  // cost him nothing at all: no sighting, and above all no `leftAt`.
  expect(await sighting(db, U.rater)).toBeNull();
  expect(await leftAt(db, U.rater)).toBeNull();
});

test("an UNRESOLVED sender writes no sighting, and the batch still succeeds", async ({
  request,
  db,
}) => {
  const body = "who's about";
  engineOn({ [body]: { route: "none" } });
  // No phone and no name: nobody can be resolved, so the message proves
  // SOMEBODY is in the group but not WHO. There is no row to refresh.
  await postAnalyze(request, [
    { waMessageId: msgId(), body, authorPhone: "", authorName: null },
  ]);

  const rows = await db.all<{ c: string }>(
    `SELECT count(*)::text AS c FROM "Membership"
      WHERE "orgId" = $1 AND "lastSeenInGroupAt" IS NOT NULL`,
    [ORG_ID],
  );
  expect(rows[0].c).toBe("0");
});

test("THROTTLE: a chatty player's second message does not move the timestamp", async ({
  request,
  db,
}) => {
  const body = "lads";
  engineOn({ [body]: { route: "none" } });

  await postAnalyze(request, [
    {
      waMessageId: msgId(),
      body,
      authorPhone: PHONE.extra.replace("+", ""),
      authorName: NAME.extra,
    },
  ]);
  const first = await sighting(db, U.extra);
  expect(first).not.toBeNull();

  // Nine more, across two further batches. The throttle window is six
  // hours, so every one of these matches zero rows.
  for (let i = 0; i < 2; i++) {
    await postAnalyze(
      request,
      Array.from({ length: 3 }, () => ({
        waMessageId: msgId(),
        body,
        authorPhone: PHONE.extra.replace("+", ""),
        authorName: NAME.extra,
      })),
    );
  }

  const after = await sighting(db, U.extra);
  expect(new Date(after!).getTime()).toBe(new Date(first!).getTime());
});

test("THE DEGRADED-MODE PIN: messages never move the SWEEP's clock", async ({ request, db }) => {
  // If `lastParticipantSweepAt` could be moved by chat, one "haha" would
  // tell the gate, the admin banner and the `sweep-stale` alert that the
  // broken sweep is healthy — and the players the degraded mode exists
  // to protect would go back to being told a falsehood, silently.
  const body = "see you thursday";
  engineOn({ [body]: { route: "none" } });
  await postAnalyze(request, [
    {
      waMessageId: msgId(),
      body,
      authorPhone: PHONE.admin.replace("+", ""),
      authorName: NAME.admin,
    },
  ]);

  expect(await sighting(db, U.admin)).not.toBeNull(); // the person WAS seen
  expect(await sweepClock(db)).toBeNull(); // the sweep still has not run
});
