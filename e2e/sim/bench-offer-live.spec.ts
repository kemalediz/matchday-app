/**
 * BENCH SLOT OFFER — LIVE-LLM validation that we never ask for a 👍.
 *
 * WHY (2026-08-31): the bench copy told a benched player "React 👍 here
 * to take it" while inbound reactions were completely dead on the Pi
 * (`reaction-forwarding is unavailable`, zero forwards ever, and
 * `SentNotification.waMessageId` NULL since 18 July). A player tapped 👍,
 * believed they had the slot, and the team turned up short.
 *
 * The copy constants are gated by BENCH_PROMPT_MENTION_REACTIONS and
 * unit-tested. This file covers the half a unit test CANNOT: what the
 * group actually receives, end to end, on a real drop.
 *
 * ── WHAT THIS SPEC IS FOR CHANGED WITH §10 STEP 8 (2026-09-06) ───────
 * It used to read: "the LLM writes the group reply to the drop itself,
 * so if SYSTEM_PROMPT still suggests '👍/👎 above' the model keeps saying
 * it however the constants are set." `SYSTEM_PROMPT` is deleted. The
 * reply to a drop is now COMPOSED — `pipeline/compose.ts` from
 * `group-copy.ts`'s constants — and a composer cannot improvise a "react
 * 👍" line at all.
 *
 * The spec is KEPT, and the reason it is kept is the reason it existed:
 * the incident was not "the prompt said the wrong thing", it was "a
 * player tapped 👍, believed they had the slot, and the team turned up
 * short". The path from a real drop to the words in the group still runs
 * through a router, an extractor, an engine, an apply layer and a
 * composer, and only an end-to-end run proves none of them puts a 👍
 * back. The RUNS loop stays too: the router and the extractor are
 * non-deterministic even though the copy is not.
 *
 * Opt-in: only runs when MT_SIM_LIVE_LLM=1.
 *
 * Run:
 *   set -a; source .env; set +a
 *   npm run test:sim:live:bench
 *
 * NO FLAGS NEEDED. §10 step 8 deleted `ROUTER_GATE_ENABLED` and
 * `ATTENDANCE_ENGINE_ENABLED` outright — with no analyzer to revert to,
 * an off position for the attendance path is a kill switch rather than a
 * lever — so the router and the engine are simply how the route works
 * now. The "a slot must open" assertion above the copy checks is what
 * stops this passing vacuously if that ever stops being true.
 *
 * NEVER weaken these assertions — fix the composer or the copy constants.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup } from "./group";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const RUNS = 3;

const ROSTER = [
  { key: "owner", name: "Oscar Owner", role: "OWNER" as const },
  { key: "alice", name: "Alice Admin", role: "ADMIN" as const },
  { key: "pete", name: "Pete Power" },
  { key: "dan", name: "Dan Drummer" },
  { key: "ehtisham", name: "Ehtisham Ekin" },
  { key: "aydin", name: "Aydın Arslan" },
  { key: "salman", name: "Salman Saric" },
];

(LIVE ? test.describe : test.describe.skip)(
  "bench slot offer LIVE (real Anthropic model)",
  () => {
    test.describe.configure({ mode: "serial" });
    test.beforeAll(resetDb);

    const mkGroup = (request: APIRequestContext, db: TestDb) =>
      createGroup(request, db, {
        maxPlayers: 5,
        players: ROSTER,
        attendance: [
          { key: "owner", status: "CONFIRMED" },
          { key: "alice", status: "CONFIRMED" },
          { key: "pete", status: "CONFIRMED" },
          { key: "dan", status: "CONFIRMED" },
          { key: "ehtisham", status: "CONFIRMED" }, // 5/5
          { key: "aydin", status: "BENCH" },
          { key: "salman", status: "BENCH" },
        ],
      });

    test(`OPEN-CALL drop with a bench: the reply never asks anyone to react (×${RUNS})`, async ({
      request,
      db,
    }) => {
      test.setTimeout(240_000);

      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkGroup(request, db)).attach(request);
        // Plain unconditional drop, nobody named. This is the OPEN-CALL
        // case: the slot goes to the whole bench, first to claim it.
        const r = await grp.post("ehtisham", "sorry lads can't make it tonight");
        const text = [r.reply ?? "", ...r.groupPosts, ...r.dms.map((d) => d.text)].join("\n");

        console.log(`[bench-live] run ${i + 1}: intent=${r.intent} reply=${JSON.stringify(r.reply)}`);

        // The slot really did open (otherwise the assertions below are vacuous).
        expect((await grp.openOffers()).length, `run ${i + 1}: a slot must open`).toBe(1);

        // THE POINT: no instruction to react, in any shape.
        expect(text, `run ${i + 1}: must not ask for a 👍`).not.toContain("👍");
        expect(text, `run ${i + 1}: must not ask for a 👎`).not.toContain("👎");
        expect(text, `run ${i + 1}: must not tell anyone to react`).not.toMatch(
          /\breact(ing|ion|s)?\b/i,
        );
        expect(text, `run ${i + 1}: must not tell anyone to tap an emoji`).not.toMatch(
          /\btap\b/i,
        );

        // Pre-existing hard rule, re-pinned: the bench is tagged IN THE
        // GROUP on this path (the analyzer used to own the wording; the
        // composer does now, and the rule did not move). The reply must
        // never claim a DM.
        expect(text, `run ${i + 1}: must not claim a DM was sent`).not.toMatch(
          /\bdm'?d\b|\bin dms\b|\bvia dm\b|privately/i,
        );
      }
    });
  },
);
