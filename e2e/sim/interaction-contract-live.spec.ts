/**
 * INTERACTION CONTRACT — LIVE-LLM validation.
 *
 * Drives the REAL Anthropic model (no stub anywhere) to confirm the
 * deterministic contract gate holds on the classification-sensitive
 * cases. Each case is run several times because the model is
 * non-deterministic; the gate must hold EVERY run.
 *
 * ── WHAT IS UNDER TEST CHANGED WITH §10 STEP 8 (2026-09-06) ──────────
 * This used to read "the deterministic gate + strengthened SYSTEM_PROMPT
 * hold together". There is no SYSTEM_PROMPT. The five cases below are
 * now a joint test of the ROUTER (does "If I was in the team it won't be
 * ruined" route `self_att`?), the EXTRACTOR (does it come back
 * `tense: past` / `contingent: true`, so no claim survives?), the ENGINE
 * and `interaction-contract.ts` — which is unchanged in meaning and is
 * still the thing the two silence assertions are about.
 *
 * EVERY ASSERTION HERE STILL DESCRIBES SHIPPED BEHAVIOUR, which is why
 * the file is ported rather than deleted: a hypothetical must not
 * register, an untagged question must be silent, a tagged one must be
 * answered, a bare In must register and a bare Out must drop. The layer
 * that decides each of those moved; none of them stopped mattering.
 *
 * Opt-in: this whole describe block only runs when MT_SIM_LIVE_LLM=1.
 * Default suites SKIP it entirely.
 *
 * Run:
 *   set -a; source .env; set +a
 *   MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/interaction-contract-live.spec.ts
 *
 * NO FLAGS NEEDED, and that is itself new: §10 step 8 deleted
 * `ROUTER_GATE_ENABLED` and `ATTENDANCE_ENGINE_ENABLED`, and inverted
 * step 7's four to default ON. DO NOT run this with a `*_ENGINE_ENABLED=0`
 * in the environment — with an owner switched off, the two SILENCE cases
 * pass for the wrong reason while the three ACTION cases fail, and a
 * green pair of silence assertions reads as the contract working.
 * `e2e/helpers/env.ts` forwards the surviving flags to the server under
 * test when they are exported.
 *
 * NEVER weaken these assertions — fix the router, the extractor or the
 * contract until they hold.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const RUNS = 4; // repeat each classification-sensitive case 4×

(LIVE ? test.describe : test.describe.skip)(
  "interaction contract LIVE (real Anthropic model)",
  () => {
    test.describe.configure({ mode: "serial" });
    test.beforeAll(resetDb);

    const mkGroup = (request: APIRequestContext, db: TestDb) =>
      createGroup(request, db, {
        maxPlayers: 14,
        attendance: [
          { key: "owner", status: "CONFIRMED" },
          { key: "alice", status: "CONFIRMED" },
          { key: "pete", status: "CONFIRMED" },
          { key: "dan", status: "CONFIRMED" },
          { key: "felix", status: "CONFIRMED" },
          { key: "greg", status: "CONFIRMED" },
        ],
      });

    test(`hypothetical "If I was in the team it won't be ruined" → NO attendance write (×${RUNS})`, async ({
      request,
      db,
    }) => {
      test.setTimeout(180_000);
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkGroup(request, db)).attach(request);
        const before = await grp.counts();
        const r = await grp.post("liam", "If I was in the team it won't be ruined");
        // eslint-disable-next-line no-console
        console.log(`[ic-live] hypothetical run ${i + 1}: intent=${r.intent} react=${r.react}`);
        expect(await grp.attendanceOf("liam"), `run ${i + 1}: liam must not be registered`).toBeNull();
        const after = await grp.counts();
        expect(after.confirmed, `run ${i + 1}`).toBe(before.confirmed);
        expect(after.bench, `run ${i + 1}`).toBe(before.bench);
      }
    });

    test(`untagged "what are the teams?" → SILENT, no reply (×${RUNS})`, async ({ request, db }) => {
      test.setTimeout(180_000);
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkGroup(request, db)).attach(request);
        const r = await grp.post("pete", "what are the teams?");
        // eslint-disable-next-line no-console
        console.log(`[ic-live] untagged-question run ${i + 1}: intent=${r.intent} reply=${JSON.stringify(r.reply)}`);
        expect(r.reply, `run ${i + 1}: must stay silent`).toBeNull();
        expect(r.groupPosts, `run ${i + 1}`).toEqual([]);
      }
    });

    test(`tagged "@Match Time what are the teams?" → ANSWERS (×${RUNS})`, async ({ request, db }) => {
      test.setTimeout(180_000);
      let answered = 0;
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkGroup(request, db)).attach(request);
        const r = await grp.post("pete", "@Match Time what are the teams?", { tag: true });
        // eslint-disable-next-line no-console
        console.log(`[ic-live] tagged-question run ${i + 1}: intent=${r.intent} hasReply=${!!r.reply}`);
        if ((r.reply ?? "").trim().length > 0 || r.groupPosts.length > 0) answered++;
      }
      // The model must answer a tagged question every run.
      expect(answered, "tagged question must be answered every run").toBe(RUNS);
    });

    test(`bare "In" → registers the sender (×${RUNS})`, async ({ request, db }) => {
      test.setTimeout(180_000);
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkGroup(request, db)).attach(request);
        const r = await grp.post("henry", "In");
        // eslint-disable-next-line no-console
        console.log(`[ic-live] bare-IN run ${i + 1}: intent=${r.intent} react=${r.react}`);
        const att = await grp.attendanceOf("henry");
        expect(att, `run ${i + 1}: henry must be registered`).not.toBeNull();
        expect(["CONFIRMED", "BENCH"]).toContain(att!.status);
      }
    });

    test(`bare "Out" → drops the sender (×${RUNS})`, async ({ request, db }) => {
      test.setTimeout(180_000);
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkGroup(request, db)).attach(request);
        // pete starts CONFIRMED; a bare OUT must drop him.
        const r = await grp.post("pete", "Out");
        // eslint-disable-next-line no-console
        console.log(`[ic-live] bare-OUT run ${i + 1}: intent=${r.intent} react=${r.react}`);
        const att = await grp.attendanceOf("pete");
        expect(att?.status, `run ${i + 1}: pete must be dropped`).toBe("DROPPED");
      }
    });
  },
);
