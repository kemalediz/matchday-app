/**
 * The off-Pi signal path, end to end against a real database.
 *
 * `src/lib/__tests__/bot-health.test.ts` pins the JUDGEMENT (which
 * thresholds, which false alarms). This spec pins the WIRING, which is
 * the half that has historically been dead: PR #13's `planFlushRetry`
 * was unreachable, four seatbelts were found dead on 2026-08-31, and the
 * unresolved-sender nudge was gated on the field its own failure mode
 * destroys. A mechanism nobody ever ran is not a mechanism.
 *
 * So: does a heartbeat actually land in the row, does the cron actually
 * read it, does it actually decide, and does the dedupe actually stop the
 * second one.
 */
import { test, expect, resetDb } from "../fixtures";
import { ORG_ID } from "../helpers/constants";
import { E2E } from "../helpers/env";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const CLEAN_COUNTERS = {
  seen: 40,
  buffered: 36,
  synthetic: 0,
  reconstructed: 0,
  notGroup: 4,
  degradedEnrichment: 0,
  nameless: 0,
  reactFailures: 0,
  flushFailures: 0,
  droppedMessages: 0,
};

async function heartbeat(
  request: APIRequestContext,
  body: Record<string, unknown>,
  key: string = E2E.WHATSAPP_API_KEY,
) {
  return request.post("/api/whatsapp/heartbeat", {
    headers: { "x-api-key": key },
    data: body,
  });
}

async function runHealthCron(request: APIRequestContext) {
  const res = await request.get("/api/cron/bot-health", {
    headers: { authorization: `Bearer ${E2E.CRON_SECRET}` },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

test.beforeAll(async () => {
  resetDb();
});

test.beforeEach(async ({ db }) => {
  await db.run(`DELETE FROM "BotHealth"`);
  await db.run(`DELETE FROM "BotJob"`);
  // Pin the participant sweep as FRESH so `sweep-stale` (a real finding,
  // and true of production today) does not colour every assertion below.
  //
  // This sets the SWEEP's own clock, not the members' sightings
  // (2026-09-09). A group message now refreshes the sender's
  // `Membership.lastSeenInGroupAt`, so that column no longer measures the
  // sweep — writing it here would prove nothing about this rule.
  await db.run(`UPDATE "Organisation" SET "lastParticipantSweepAt" = now() WHERE id = $1`, [
    ORG_ID,
  ]);
});

test("the Pi's heartbeat lands on the org's health row", async ({ request, db }) => {
  const res = await heartbeat(request, {
    groupId: E2E.GROUP_ID,
    processStartedAt: "2026-09-09T06:00:00.000Z",
    botVersion: "e2e",
    counters: CLEAN_COUNTERS,
    degradedCapabilities: [],
  });
  expect(res.status(), await res.text()).toBe(200);

  const rows = await db.all<{ seen: number; buffered: number; botVersion: string }>(
    `SELECT "seen", "buffered", "botVersion" FROM "BotHealth" WHERE "orgId" = $1`,
    [ORG_ID],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].seen).toBe(40);
  expect(rows[0].buffered).toBe(36);
  expect(rows[0].botVersion).toBe("e2e");
});

test("a second heartbeat updates the SAME row — one per org, forever", async ({
  request,
  db,
}) => {
  await heartbeat(request, { groupId: E2E.GROUP_ID, counters: CLEAN_COUNTERS });
  await heartbeat(request, {
    groupId: E2E.GROUP_ID,
    counters: { ...CLEAN_COUNTERS, seen: 99 },
  });
  const rows = await db.all<{ seen: number }>(
    `SELECT "seen" FROM "BotHealth" WHERE "orgId" = $1`,
    [ORG_ID],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].seen).toBe(99);
});

test("a heartbeat for a group MatchTime does not know is accepted and dropped", async ({
  request,
  db,
}) => {
  // Never a 4xx. The Pi monitors onboarding groups that have no org yet,
  // and a group can be disabled between two ticks; making the Pi log
  // errors about either would be noise in the one log we are trying to
  // make readable.
  const res = await heartbeat(request, { groupId: "not-a-real-group@g.us" });
  expect(res.status()).toBe(200);
  expect((await res.json()).ignored).toBe("unknown-group");
  expect(await db.all(`SELECT 1 FROM "BotHealth"`)).toHaveLength(0);
});

test("the heartbeat endpoint requires the API key", async ({ request }) => {
  const res = await heartbeat(request, { groupId: E2E.GROUP_ID }, "wrong-key");
  expect(res.status()).toBe(401);
});

test("the cron says nothing about a healthy org", async ({ request, db }) => {
  await heartbeat(request, { groupId: E2E.GROUP_ID, counters: CLEAN_COUNTERS });
  const out = await runHealthCron(request);
  const row = out.report.find((r: { org: string }) => r.org === "E2E Test FC");
  expect(row.codes).toEqual([]);
  expect(row.sent).toBe(false);
  const alerts = await db.all<{ lastAlertAt: Date | null }>(
    `SELECT "lastAlertAt" FROM "BotHealth" WHERE "orgId" = $1`,
    [ORG_ID],
  );
  expect(alerts[0].lastAlertAt).toBeNull();
});

test("the cron alerts on a degraded layer, and remembers that it did", async ({
  request,
  db,
}) => {
  await heartbeat(request, {
    groupId: E2E.GROUP_ID,
    counters: { ...CLEAN_COUNTERS, synthetic: 7, droppedMessages: 2 },
    degradedCapabilities: ["participant-sync"],
  });
  const out = await runHealthCron(request);
  const row = out.report.find((r: { org: string }) => r.org === "E2E Test FC");
  expect(row.sent).toBe(true);
  expect(row.codes).toContain("synthetic-ids");
  expect(row.codes).toContain("messages-dropped");
  expect(row.codes).toContain("capability-degraded");

  const stored = await db.all<{ lastAlertCodes: string[] }>(
    `SELECT "lastAlertCodes" FROM "BotHealth" WHERE "orgId" = $1`,
    [ORG_ID],
  );
  expect(stored[0].lastAlertCodes).toContain("synthetic-ids");
});

test("the same fault an hour later does NOT alert again", async ({ request }) => {
  await heartbeat(request, {
    groupId: E2E.GROUP_ID,
    counters: { ...CLEAN_COUNTERS, synthetic: 7 },
  });
  const first = await runHealthCron(request);
  expect(first.report.find((r: { org: string }) => r.org === "E2E Test FC").sent).toBe(true);

  const second = await runHealthCron(request);
  const row = second.report.find((r: { org: string }) => r.org === "E2E Test FC");
  expect(row.sent).toBe(false);
  expect(row.reason).toContain("repeat window");
});

test("a NEW fault landing on top of an old one speaks immediately", async ({ request }) => {
  await heartbeat(request, {
    groupId: E2E.GROUP_ID,
    counters: { ...CLEAN_COUNTERS, synthetic: 7 },
  });
  await runHealthCron(request);

  await heartbeat(request, {
    groupId: E2E.GROUP_ID,
    counters: { ...CLEAN_COUNTERS, synthetic: 7, droppedMessages: 3 },
  });
  const out = await runHealthCron(request);
  const row = out.report.find((r: { org: string }) => r.org === "E2E Test FC");
  expect(row.sent).toBe(true);
  expect(row.reason).toContain("new condition");
});

test("the cron requires the cron secret", async ({ request }) => {
  const res = await request.get("/api/cron/bot-health", {
    headers: { authorization: "Bearer nope" },
  });
  expect(res.status()).toBe(401);
});

test("no heartbeat at all is not treated as an outage", async ({ request }) => {
  // The server ships on merge; the Pi is deployed by hand. A healthy Pi on
  // an older build sends nothing here, and paging for that would guarantee
  // a false alarm on the day this shipped.
  const out = await runHealthCron(request);
  const row = out.report.find((r: { org: string }) => r.org === "E2E Test FC");
  expect(row.codes).not.toContain("pi-silent");
});
