/**
 * THE LAST GAP IN FRONT OF `ROUTER_GATE_ENABLED`, THROUGH THE REAL
 * ANALYZE ROUTE.
 *
 * PR #42 routed all 1,695 production messages that have a body through
 * the real router and found exactly two that are an attendance write the
 * gate would have lost. Both are a bare `👍`:
 *
 *   2026-05-05  Aydın Kocahal `👍` → `IN`, answering the
 *               `PendingBenchConfirmation` MatchTime opened at 07:12.
 *   2026-06-15  Aydın Kocahal `👍` → `IN`, claiming the `BenchSlotOffer`
 *               opened at 20:40 when Ehtisham Ul Haq dropped.
 *
 * The unit tests prove the routing decision. This proves the wiring: the
 * analyze route loads the fact, hands it to the gate, and the write
 * lands. Without this spec the production path — one `loadOpenQuestion`
 * call in `route.ts` — has no coverage at all.
 *
 * And the direction that matters more, because it is the larger
 * population by hundreds to one: the identical `👍`, with nothing open,
 * is still thrown away.
 */
import { test, expect, resetDb } from "../fixtures";
import { createGroup } from "./group";
import { clearRouterStub } from "../helpers/stub";
import { selfIn } from "../helpers/stub";

/* ── PORTED 2026-09-06, §10 STEP 8 ────────────────────────────────────
 *
 * Every case here posted a bare 👍 with `verdict: { registerAttendance:
 * "IN" }` sitting behind it, and asserted whether the ANALYZER got to
 * see it. There is no analyzer, so "did it reach the analyzer?" is now
 * "did it reach an OWNER?", and the verdict is a `self_att` claim the
 * attendance extractor returns.
 *
 * The MECHANISM under test is untouched, and it is the reason this file
 * exists: `awaiting-answer.ts` moves a message OUT of `none` when — and
 * only when — the database says MatchTime is waiting on THIS sender for
 * THIS match. All five negative cases (resolved, stale, another club's,
 * and the two shapes of "nothing open") still assert that the 👍 is
 * thrown away, and they are the population that outnumbers the positive
 * by hundreds to one.
 *
 * ONE CASE WAS DELETED — "with the gate OFF, an open slot changes
 * nothing at all". `ROUTER_GATE_ENABLED` is deleted (`pipeline/gate.ts`)
 * along with the analyzer its off position reverted to; there is no
 * gate-off arm left to compare against. `gate.ts`'s essay and
 * `__tests__/gate.test.ts`'s tombstone carry the argument.
 */
const THUMB = { route: "none", facts: selfIn() };

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

/** Open a bench slot the way a confirmed player dropping does. */
async function openBenchSlot(
  db: { run(sql: string, params?: unknown[]): Promise<void> },
  matchId: string,
  id: string,
  minutesAgo = 5,
): Promise<void> {
  // `now()` is a timestamptz and these columns are naive `timestamp`, so
  // the cast would silently shift by the session's UTC offset — under
  // BST that lands the row an hour in the FUTURE and nothing is open.
  await db.run(
    `INSERT INTO "BenchSlotOffer" ("id", "matchId", "replacingUserId", "createdAt", "updatedAt")
     VALUES ($1, $2, NULL,
             (now() AT TIME ZONE 'UTC') - ($3 || ' minutes')::interval,
             now() AT TIME ZONE 'UTC')`,
    [id, matchId, String(minutesAgo)],
  );
}

(LIVE ? test.describe.skip : test.describe)(
  "the router gate, while MatchTime is waiting for an answer",
  () => {
    test.describe.configure({ mode: "serial" });
    test.beforeAll(resetDb);
    test.afterEach(() => clearRouterStub());

    test("THE GAP: a bare 👍 the router calls banter still registers, because a slot is open", async ({
      request,
      db,
    }) => {
      const g = await createGroup(request, db, {
        attendance: [{ key: "alice", status: "BENCH" }],
      });
      await openBenchSlot(db, g.matchId!, `offer-open-${g.orgId}`);

      // The router says exactly what it said in production: `none`.
      await g.postBatch([{ player: "alice", body: "👍", ...THUMB }]);

      const row = await db.one<{ handledBy: string }>(
        `SELECT "handledBy" FROM "AnalyzedMessage" WHERE "orgId" = $1 AND body = '👍'`,
        [g.orgId],
      );
      // It reached an OWNER. `awaiting` rewrote `none` to an engine
      // route, so the audit column names the engine; it read `llm` while
      // the analyzer was the thing on the far side of that rewrite.
      expect(row?.handledBy).toBe("attendance-engine");
      expect(await g.attendanceOf("alice")).toMatchObject({ status: "CONFIRMED" });
    });

    test("THE NEGATIVE: the identical 👍, with nothing open, is still thrown away", async ({
      request,
      db,
    }) => {
      // Same message, same router answer, same stubbed verdict waiting
      // behind it. The ONLY difference is that MatchTime has not asked
      // anything — which is the whole mechanism, and the reason this is
      // not a `👍` pattern in the floor.
      const g = await createGroup(request, db, {
        attendance: [{ key: "alice", status: "BENCH" }],
      });
      await g.postBatch([{ player: "alice", body: "👍", ...THUMB }]);

      expect(await g.attendanceOf("alice")).toMatchObject({ status: "BENCH" });
      const row = await db.one<{ handledBy: string; reasoning: string }>(
        `SELECT "handledBy", reasoning FROM "AnalyzedMessage" WHERE "orgId" = $1 AND body = '👍'`,
        [g.orgId],
      );
      expect(row?.handledBy).toBe("router-gate");
    });

    test("a question that has already been ANSWERED is not still waiting", async ({
      request,
      db,
    }) => {
      const g = await createGroup(request, db, {
        attendance: [{ key: "alice", status: "BENCH" }],
      });
      const id = `offer-resolved-${g.orgId}`;
      await openBenchSlot(db, g.matchId!, id);
      await db.run(
        `UPDATE "BenchSlotOffer" SET "resolvedAt" = now() AT TIME ZONE 'UTC', outcome = 'claimed' WHERE id = $1`,
        [id],
      );

      await g.postBatch([{ player: "alice", body: "👍", ...THUMB }]);

      expect(await g.attendanceOf("alice")).toMatchObject({ status: "BENCH" });
    });

    test("a question nobody answered for two hours is not still waiting either", async ({
      request,
      db,
    }) => {
      // The TTL. A `BenchSlotOffer` lives until kickoff — one real one
      // stayed open for 22 hours — and treating all of that as "waiting"
      // would drag a day of banter into the analyzer.
      const g = await createGroup(request, db, {
        attendance: [{ key: "alice", status: "BENCH" }],
      });
      await openBenchSlot(db, g.matchId!, `offer-stale-${g.orgId}`, 120);

      await g.postBatch([{ player: "alice", body: "👍", ...THUMB }]);

      expect(await g.attendanceOf("alice")).toMatchObject({ status: "BENCH" });
    });

    test("ANOTHER club's open slot changes nothing in this group", async ({ request, db }) => {
      const other = await createGroup(request, db, { attendance: [] });
      await openBenchSlot(db, other.matchId!, `offer-other-${other.orgId}`);

      const g = await createGroup(request, db, {
        attendance: [{ key: "alice", status: "BENCH" }],
      });
      await g.postBatch([{ player: "alice", body: "👍", ...THUMB }]);

      expect(await g.attendanceOf("alice")).toMatchObject({ status: "BENCH" });
    });

    /* ── DELETED 2026-09-06 (§10 step 8): "with the gate OFF, an open
     * slot changes nothing at all".
     *
     * It set `clearRouterStub()` so `ROUTER_GATE_ENABLED` fell back to
     * the environment (off) and asserted the 👍 registered anyway, via
     * the analyzer, with no `router-gate` row anywhere. The flag is
     * deleted from `pipeline/gate.ts` and so is the analyzer, so there is
     * no off arm and nothing for it to have reverted to; `routerIsNeeded()`
     * takes no arguments and returns true. `__tests__/gate.test.ts`
     * ("names no predicate for a flag that was deleted") is the tombstone
     * for the name itself. */
  },
);
