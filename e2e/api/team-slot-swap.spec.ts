/**
 * THE 2026-09-08 ELVIN/RAIHAN INCIDENT, END TO END THROUGH THE REAL
 * ROUTE.
 *
 * `src/lib/__tests__/team-slot-swap.test.ts` pins the DECISION for all
 * 64 states. This file pins the only thing that spec cannot: that the
 * decision reaches Postgres, that it reaches ONLY `TeamAssignment`, and
 * that the reply carries the line-up the message asked for.
 *
 * Production, the afternoon of a match:
 *
 *   15:25  Elvin:  "please can someone replace me, not feeling well"
 *                  → DROPPED, still holding a RED slot.
 *   16:15  Wasim:  "I have a friend who will play instead of my dad.
 *                   His name is Raihan"       → CONFIRMED, no slot.
 *   16:47  Kemal:  "@Match Time do not regenerate the teams. Instead
 *                   swap Elvin with Raihan and share us the teams"
 *                  → NOTHING HAPPENED. The pre-peel matched the
 *                    sentence and declined on "both must be CONFIRMED";
 *                    the message reached `balancer`, which owns no
 *                    `swap`, and the owner got one operator note while
 *                    the team sheet still named a man who had gone home.
 *
 * Cast, in the fixture world: Pat Player is Elvin (drops out holding
 * RED), Ian Innes is Raihan (arrives, confirmed, no slot).
 *
 * The route is driven with NO stub for the incident message on purpose.
 * The swap peel runs before the router on the raw body, so if this test
 * needed a stubbed route it would be testing the wrong code.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { engineOn } from "../helpers/stub";
import { U, PHONE, MATCH, NAME } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

let n = 0;
const msgId = () => `e2e-slotswap-${Date.now()}-${++n}`;

interface Row {
  name: string;
  v: string;
}

/** The team sheet as "Name:TEAM", ordered — the thing that was stale. */
async function sheet(db: TestDb): Promise<string[]> {
  const rows = await db.all<Row>(
    `SELECT u.name AS name, t.team::text AS v
       FROM "TeamAssignment" t JOIN "User" u ON u.id = t."userId"
      WHERE t."matchId" = $1
      ORDER BY u.name`,
    [MATCH.upcoming],
  );
  return rows.map((r) => `${r.name}:${r.v}`);
}

/** Every attendance row as "Name:STATUS". A swap must never move one. */
async function squad(db: TestDb): Promise<string[]> {
  const rows = await db.all<Row>(
    `SELECT u.name AS name, a.status::text AS v
       FROM "Attendance" a JOIN "User" u ON u.id = a."userId"
      WHERE a."matchId" = $1
      ORDER BY u.name`,
    [MATCH.upcoming],
  );
  return rows.map((r) => `${r.name}:${r.v}`);
}

async function matchStatus(db: TestDb): Promise<string | undefined> {
  const row = await db.one<{ v: string }>(
    `SELECT status::text AS v FROM "Match" WHERE id = $1`,
    [MATCH.upcoming],
  );
  return row?.v;
}

/**
 * The world at 16:47: a generated sheet, one player DROPPED but still
 * on it, and his replacement confirmed with nowhere to stand.
 */
async function seedTheIncident(db: TestDb): Promise<void> {
  // Pat pulled out at 15:25 — DROPPED, but the sheet was built before
  // that and still has him on RED.
  await db.run(`UPDATE "Attendance" SET status = 'DROPPED' WHERE "matchId" = $1 AND "userId" = $2`, [
    MATCH.upcoming,
    U.player,
  ]);
  // Ian arrived at 16:15 as somebody's replacement — CONFIRMED, no slot.
  await db.run(
    `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "respondedAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'CONFIRMED', 6, now(), now(), now())
     ON CONFLICT ("matchId", "userId") DO UPDATE SET status = 'CONFIRMED'`,
    [`e2e-att-slotswap-${U.fresh}`, MATCH.upcoming, U.fresh],
  );
  await db.run(`DELETE FROM "TeamAssignment" WHERE "matchId" = $1`, [MATCH.upcoming]);
  const rows: Array<[string, string]> = [
    [U.admin, "RED"],
    [U.player, "RED"], // ← the stale slot
    [U.collector, "YELLOW"],
    [U.third, "YELLOW"],
  ];
  for (const [userId, team] of rows) {
    await db.run(
      `INSERT INTO "TeamAssignment" (id, "matchId", "userId", team)
       VALUES ($1, $2, $3, $4::"Team")`,
      [`e2e-ta-slotswap-${userId}`, MATCH.upcoming, userId, team],
    );
  }
}

test.describe("the replacement transfer — 2026-09-08", () => {
  test.beforeEach(async ({ db }) => {
    resetDb();
    await seedTheIncident(db);
  });

  test("moves the dropped player's slot to his replacement, and nothing else", async ({
    request,
    db,
  }) => {
    const before = await squad(db);

    const res = await postAnalyze(request, [
      {
        waMessageId: msgId(),
        body: `@Match Time do not regenerate the teams. Instead swap ${NAME.player.split(" ")[0]} with ${NAME.fresh.split(" ")[0]} and share us the teams`,
        authorPhone: PHONE.admin,
        authorName: NAME.admin,
        botMentioned: true,
      },
    ]);

    // THE SHEET MOVED, and only by one row: Ian holds Pat's RED.
    expect((await sheet(db)).sort()).toEqual(
      [
        `${NAME.admin}:RED`,
        `${NAME.fresh}:RED`,
        `${NAME.collector}:YELLOW`,
        `${NAME.third}:YELLOW`,
      ].sort(),
    );

    // NOT ONE ATTENDANCE ROW MOVED. Pat is still DROPPED, Ian still
    // CONFIRMED, the bench untouched. A swap moves a slot; that is all.
    expect(await squad(db)).toEqual(before);

    // AND THE BALANCER NEVER RAN. `generate` moves the match to
    // TEAMS_GENERATED; the message said not to, and it did not.
    expect(await matchStatus(db)).toBe("UPCOMING");

    // "share us the teams" — the reply IS the line-up.
    const owned = res.results.find(
      (r: { intent: string }) => r.intent === "team_swap",
    );
    expect(owned, JSON.stringify(res.results)).toBeTruthy();
    const reply: string = owned.reply;
    expect(reply).toContain(NAME.fresh);
    expect(reply).toContain(NAME.player);
    expect(reply).toContain(NAME.admin);
    expect(reply).toContain(NAME.third);
  });

  test("reads the same the other way round — 'swap Ian with Pat'", async ({ request, db }) => {
    await postAnalyze(request, [
      {
        waMessageId: msgId(),
        body: `@Match Time swap ${NAME.fresh.split(" ")[0]} with ${NAME.player.split(" ")[0]}`,
        authorPhone: PHONE.admin,
        authorName: NAME.admin,
        botMentioned: true,
      },
    ]);
    expect(await sheet(db)).toContain(`${NAME.fresh}:RED`);
    expect(await sheet(db)).not.toContain(`${NAME.player}:RED`);
  });

  test("a NON-ADMIN may ask — a slot transfer changes nobody's squad standing", async ({
    request,
    db,
  }) => {
    // The person who knows a replacement has arrived is the player who
    // brought them. On 2026-09-08 that was Wasim, not an admin. The tag
    // is the deliberate act; see the contract note in team-slot-swap.ts.
    await postAnalyze(request, [
      {
        waMessageId: msgId(),
        body: `@Match Time swap ${NAME.player.split(" ")[0]} with ${NAME.fresh.split(" ")[0]}`,
        authorPhone: PHONE.rater, // Riley Rater — an ordinary member
        authorName: NAME.rater,
        botMentioned: true,
      },
    ]);
    expect(await sheet(db)).toContain(`${NAME.fresh}:RED`);
  });

  test("REFUSES rather than guesses when neither named player is playing", async ({
    request,
    db,
  }) => {
    // Ben is BENCH with no slot, Pat is DROPPED with one. Neither is in
    // the squad, so there is no correct occupant to move the slot TO —
    // `nobody-is-playing`. The peel must NOT own this: owning it would
    // splice the message out of the batch and delete every other clause
    // in it. It falls through to the router, stubbed to `none` here so
    // the assertion is about the peel and not about an owner.
    const body = `@Match Time swap ${NAME.bench.split(" ")[0]} with ${NAME.player.split(" ")[0]}`;
    engineOn({ [body]: { route: "none" } });
    const before = await sheet(db);

    const res = await postAnalyze(request, [
      {
        waMessageId: msgId(),
        body,
        authorPhone: PHONE.admin,
        authorName: NAME.admin,
        botMentioned: true,
      },
    ]);

    expect(await sheet(db)).toEqual(before);
    expect(res.results.map((r: { intent: string }) => r.intent)).not.toContain("team_swap");
  });
});

test.describe("the shipped both-CONFIRMED team swap still works", () => {
  test.beforeEach(async ({ db }) => {
    resetDb();
    await seedTheIncident(db);
    // Put Pat back in the squad: now it is the 2026-05-19 case again,
    // two confirmed players trading sides.
    await db.run(
      `UPDATE "Attendance" SET status = 'CONFIRMED' WHERE "matchId" = $1 AND "userId" = $2`,
      [MATCH.upcoming, U.player],
    );
  });

  test("exchanges two confirmed players' sides, drops nobody", async ({ request, db }) => {
    const before = await squad(db);
    await postAnalyze(request, [
      {
        waMessageId: msgId(),
        body: `@Match Time swap ${NAME.player.split(" ")[0]} with ${NAME.third.split(" ")[0]}`,
        authorPhone: PHONE.admin,
        authorName: NAME.admin,
        botMentioned: true,
      },
    ]);
    const after = await sheet(db);
    expect(after).toContain(`${NAME.player}:YELLOW`);
    expect(after).toContain(`${NAME.third}:RED`);
    expect(await squad(db)).toEqual(before);
  });
});
