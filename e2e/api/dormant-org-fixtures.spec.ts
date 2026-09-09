/**
 * A dormant club stops getting fixtures. A muted one does not.
 *
 * `src/lib/__tests__/org-lifecycle.test.ts` pins the JUDGEMENT (which
 * signal, and why not the other one). This spec pins the WIRING against
 * a real database and the real cron route, because the bug was never in
 * a predicate — it was that `/api/cron/generate-matches` queried
 * `Activity.isActive` and never joined the organisation at all.
 *
 * Sutton Lads churned 2026-06-18 (MatchTime removed from the group after
 * an incident, org left dormant, data retained on purpose). Its Thursday
 * Activity stayed `isActive: true`, so the weekly cron kept minting
 * fixtures for a club that no longer exists — one for Thu 10 Sept 2026
 * surfaced in a status report almost three months later.
 *
 * The regression this spec exists to prevent is the OTHER direction:
 * Sutton FC, live and playing, was muted twice in the week of 2026-09-06
 * with `whatsappBotEnabled = false` during engineering work. Its
 * fixtures kept generating, correctly. Any fix that gates generation on
 * the mute switch silently costs a live club its next squad, which is
 * worse than the bug being fixed. The MUTED org below is that case.
 *
 * Deterministic server code end to end: no LLM is involved in fixture
 * generation, so there is no live-LLM variant of this spec.
 */
import { test, expect, resetDb } from "../fixtures";
import { E2E } from "../helpers/env";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

// Deliberately NOT `mode: "serial"`. `beforeEach` rebuilds all three
// clubs from scratch, so no test depends on another's state, and a
// failure in one should not hide the verdict of the rest — this file's
// value is the four-way contrast between the lifecycle states.

/** Three clubs, one per lifecycle state, plus a dead format inside the live one. */
const ORG = {
  live: "e2e-org-live",
  muted: "e2e-org-muted",
  dormant: "e2e-org-dormant",
} as const;

const ACTIVITY = {
  live: "e2e-act-live",
  muted: "e2e-act-muted",
  dormant: "e2e-act-dormant",
  /** In the LIVE org, `isActive: false` — the pre-existing per-fixture switch. */
  liveInactive: "e2e-act-live-inactive",
} as const;

const ALL_ORG_IDS = Object.values(ORG);
const ALL_ACTIVITY_IDS = Object.values(ACTIVITY);

async function runGenerateMatches(request: APIRequestContext) {
  const res = await request.get("/api/cron/generate-matches", {
    headers: { authorization: `Bearer ${E2E.CRON_SECRET}` },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json() as Promise<{ created: number; skippedDormantOrgs?: number }>;
}

/** How many matches the cron has made for one of this spec's activities. */
async function matchCount(db: TestDb, activityId: string): Promise<number> {
  return db.count(`SELECT COUNT(*) FROM "Match" WHERE "activityId" = $1`, [activityId]);
}

test.beforeAll(async () => {
  resetDb();
});

test.beforeEach(async ({ db }) => {
  // Rebuild the three clubs from scratch each time so the dedupe state
  // of one test can never decide another's outcome.
  await db.run(`DELETE FROM "Match" WHERE "activityId" = ANY($1::text[])`, [ALL_ACTIVITY_IDS]);
  await db.run(`DELETE FROM "Organisation" WHERE "id" = ANY($1::text[])`, [ALL_ORG_IDS]);

  // Every club plays on a DIFFERENT weekday and at a different venue, so
  // the generator's recurring-slot dedupe (orgId + venue + dayOfWeek +
  // instant, see src/lib/match-slot.ts) can never confuse two of them —
  // and none of them collides with the seeded fixture world's Tuesday.
  const clubs = [
    { org: ORG.live, activity: ACTIVITY.live, name: "E2E Live FC", bot: true, dormant: null, day: 3, venue: "Live Park" },
    { org: ORG.muted, activity: ACTIVITY.muted, name: "E2E Muted FC", bot: false, dormant: null, day: 4, venue: "Muted Park" },
    { org: ORG.dormant, activity: ACTIVITY.dormant, name: "E2E Dormant FC", bot: false, dormant: "2026-06-18T12:00:00Z", day: 5, venue: "Dormant Park" },
  ];

  for (const c of clubs) {
    await db.run(
      `INSERT INTO "Organisation"
         ("id","name","slug","inviteCode","whatsappBotEnabled","dormantAt","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,now(),now())`,
      [c.org, c.name, c.org, `${c.org}-invite`, c.bot, c.dormant],
    );
    await db.run(
      `INSERT INTO "Sport"
         ("id","orgId","name","playersPerTeam","positions","teamLabels","createdAt","updatedAt")
       VALUES ($1,$2,'Football 5-a-side',5,ARRAY['GK','DEF','MID','FWD'],ARRAY['Red','Yellow'],now(),now())`,
      [`${c.org}-sport`, c.org],
    );
    await db.run(
      `INSERT INTO "Activity"
         ("id","orgId","sportId","name","dayOfWeek","time","venue","isActive","deadlineHours","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,'20:00',$6,true,5,now(),now())`,
      [c.activity, c.org, `${c.org}-sport`, `${c.name} weekly`, c.day, c.venue],
    );
  }

  // A deactivated Activity inside the LIVE org — the format-switch
  // leftover shape. Different venue AND weekday from the live one so its
  // absence is proof of `isActive`, not of slot dedupe.
  await db.run(
    `INSERT INTO "Activity"
       ("id","orgId","sportId","name","dayOfWeek","time","venue","isActive","deadlineHours","createdAt","updatedAt")
     VALUES ($1,$2,$3,'E2E Live FC old format',6,'20:00','Retired Park',false,5,now(),now())`,
    [ACTIVITY.liveInactive, ORG.live, `${ORG.live}-sport`],
  );
});

test.afterAll(async () => {
  // Leave the fixture world exactly as the next spec file expects it:
  // this cron writes a Match for the seeded org too.
  resetDb();
});

test("a dormant org's ACTIVE activity generates no fixture", async ({ request, db }) => {
  await runGenerateMatches(request);
  expect(await matchCount(db, ACTIVITY.dormant)).toBe(0);
});

test("a live org's active activity still generates one — unchanged", async ({ request, db }) => {
  await runGenerateMatches(request);
  expect(await matchCount(db, ACTIVITY.live)).toBe(1);
});

test("a MUTED but live org still generates — muting is engineering, not churn", async ({
  request,
  db,
}) => {
  // The regression that matters most. Sutton FC was muted twice in the
  // week of 2026-09-06 and kept playing.
  await runGenerateMatches(request);
  expect(await matchCount(db, ACTIVITY.muted)).toBe(1);
});

test("an inactive activity in a live org generates nothing — unchanged", async ({
  request,
  db,
}) => {
  await runGenerateMatches(request);
  expect(await matchCount(db, ACTIVITY.liveInactive)).toBe(0);
});

test("the cron reports how many activities it skipped for dormancy", async ({ request }) => {
  // Observability, so a skip is visible in the cron log rather than
  // being indistinguishable from "there was nothing to do".
  const body = await runGenerateMatches(request);
  expect(body.skippedDormantOrgs).toBe(1);
});

test("re-running the cron creates nothing new anywhere", async ({ request, db }) => {
  await runGenerateMatches(request);
  const second = await runGenerateMatches(request);
  expect(second.created).toBe(0);
  expect(await matchCount(db, ACTIVITY.live)).toBe(1);
  expect(await matchCount(db, ACTIVITY.muted)).toBe(1);
  expect(await matchCount(db, ACTIVITY.dormant)).toBe(0);
});

test("marking a live org dormant stops its fixtures from the next run on", async ({
  request,
  db,
}) => {
  // The whole point of the column: an operator flips one field and the
  // generator stops, without touching a single Activity.
  await runGenerateMatches(request);
  expect(await matchCount(db, ACTIVITY.live)).toBe(1);

  await db.run(`DELETE FROM "Match" WHERE "activityId" = $1`, [ACTIVITY.live]);
  await db.run(`UPDATE "Organisation" SET "dormantAt" = now() WHERE "id" = $1`, [ORG.live]);

  await runGenerateMatches(request);
  expect(await matchCount(db, ACTIVITY.live)).toBe(0);

  // …and un-marking it brings them back. Dormancy is reversible; the
  // club that comes back next season is not a new club.
  await db.run(`UPDATE "Organisation" SET "dormantAt" = NULL WHERE "id" = $1`, [ORG.live]);
  await runGenerateMatches(request);
  expect(await matchCount(db, ACTIVITY.live)).toBe(1);
});

test("the cron still refuses an unauthorised caller", async ({ request }) => {
  const res = await request.get("/api/cron/generate-matches", {
    headers: { authorization: "Bearer nope" },
  });
  expect(res.status()).toBe(401);
});
