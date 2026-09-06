/**
 * Group-simulator scenario matrix — Q&A + privacy.
 *
 * - "who's on the bench?" → the bench section is composed from the
 *   database (bench always shown, correctly).
 * - A `stats` question is one the answer engine does NOT own, so it
 *   reaches nobody and MatchTime stays silent (§10 step 7's carve-out).
 * - DM Q&A (scoped, no-leak): the context the model sees NEVER contains a
 *   raw phone number; the 📵 "no number on record" flags appear ONLY for
 *   admins (so "who's missing a number?" is admin-only in DMs). Asserted
 *   structurally via the test-only stub in dm-qa.ts, which returns the
 *   scoped context itself instead of calling Anthropic.
 * - Group → DM ("dm me …") answers privately with 📩.
 * - "my stats" fast-path DMs a personal magic link with 📊.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";
import { selfIn } from "../helpers/stub";

/* ── PORTED 2026-09-06, §10 STEP 8 ────────────────────────────────────
 *
 * The first two cases fed a WRONG answer as a verdict and asserted the
 * server corrected it. There is no answer to feed: since §10 step 7 the
 * question route's reply is composed by `pipeline/compose.ts` from a
 * `SquadState` read out of the database, so the only thing a stub can
 * say is what the question was ABOUT (`topic`), and being right is not
 * optional any more — it is structural.
 *
 * The FIVE DM / fast-path cases below never touched the verdict seam at
 * all. They are the reason `MT_TEST_LLM_STUB_FILE` could not simply be
 * deleted with `analyzeBatch`: `dm-qa.ts` keys its own stub off that
 * variable being SET, never off the file's contents. The variable is now
 * called `MT_TEST_DM_QA_STUB` and does exactly that one job.
 */
const askBench = { route: "question", facts: { topic: "bench", personRef: null, statedCount: null } };

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

// Every sim phone starts with this — if these digits show up in any DM
// answer/context, a number leaked.
const PHONE_MARKER = "4477009";

let g: SimGroup;
const group = async (request: APIRequestContext, db: TestDb) =>
  (g ??= await createGroup(request, db, {
    maxPlayers: 14,
    attendance: [
      { key: "owner", status: "CONFIRMED" },
      { key: "alice", status: "CONFIRMED" },
      { key: "pete", status: "CONFIRMED" },
      { key: "dan", status: "CONFIRMED" },
      { key: "gary", status: "CONFIRMED" }, // no phone on record
      { key: "larry", status: "CONFIRMED" }, // @lid, no phone on record
      { key: "greg", status: "BENCH" },
    ],
  })).attach(request);

test('"who\'s on the bench?" → answered from the DB, not from anyone\'s claim', async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.post("alice", "@Match Time who's on the bench?", {
    // Interaction contract: a question is answer-y → requires a tag.
    tag: true,
    ...askBench,
  });
  // The COPY changed with the answerer. It used to be the batch-final
  // squad post's "*Bench (1):*" block, because the only way to correct a
  // wrong bench claim was to replace the whole reply with the squad
  // post. The `bench` topic has its own composed answer now
  // (`compose.ts`, "On the bench: …"), which is a narrower thing to say
  // and the right one for the question asked. What is asserted is the
  // same as before and is the point of the test: the answer is the
  // DATABASE's bench, named.
  expect(r.reply).toContain("Greg Gale");
  expect(r.reply, "and nobody who is not on the bench").not.toContain("Pete Power");
});

/* ── REPLACED 2026-09-06, §10 STEP 8. THE OLD CASE HAD NO SUBJECT. ────
 *
 * WAS: "leaderboard replies pass through verbatim — never collapsed or
 * canonicalised". It handed the route a finished leaderboard as
 * `verdict.reply` and asserted the squad-post collapse did not eat it.
 * Both halves are gone: nothing hands the route a reply any more, and
 * §10 step 4 replaced the collapse/canonicalise post-processors with
 * composition, so there is no machinery for a non-squad-state reply to
 * survive.
 *
 * WHAT REPLACES IT is the same worry answered by the shipped design:
 * `stats` is a `QuestionTopic` the answer engine does NOT own
 * (`answer-batch.ts`'s carve-outs), so a standings question in a batch
 * that also carries a write reaches nobody and MatchTime says nothing
 * about it — while the write still lands and still gets its own reply.
 * That is the honest successor: not "the leaderboard survives" but "the
 * batch does not invent one", and the write beside it is untouched.
 */
test("a stats question in a writing batch is unowned, and the write beside it still lands", async ({ request, db }) => {
  const grp = await group(request, db);
  const batch = await grp.postBatch([
    { player: "felix", body: "in", route: "self_att", facts: selfIn() },
    {
      player: "owner",
      body: "@Match Time who's top of the standings?",
      tag: true, // question → requires a tag under the interaction contract
      route: "question",
      facts: { topic: "stats", personRef: null, statedCount: null },
    },
  ]);
  expect((await grp.attendanceOf("felix"))?.status).toBe("CONFIRMED");
  expect(batch.results[1].reply, "nobody owns a stats question").toBeNull();
  expect(batch.results[1].handledBy).toBe("ignored");
});

test('DM "what\'s X\'s number?" — context physically contains NO phone digits and no 📵 flags for a non-admin', async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.dm("pete", "what's Gary's phone number?");
  expect(r.json.handled).toBe("dm-qa");
  const answer = r.dms.find((d) => d.text.startsWith("[scoped-qa-stub]"));
  expect(answer).toBeTruthy();
  expect(answer!.text).toContain("Confirmed players:");
  // The no-leak guarantee, structurally: nothing to extract.
  expect(answer!.text).not.toContain(PHONE_MARKER);
  expect(answer!.text).not.toContain("📵");
});

test('DM "who\'s missing a number?" — 📵 flags present for an ADMIN, still zero raw digits', async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.dm("alice", "who's missing a number on record?");
  expect(r.json.handled).toBe("dm-qa");
  const answer = r.dms.find((d) => d.text.startsWith("[scoped-qa-stub]"));
  expect(answer).toBeTruthy();
  // Exactly the phone-less squad members are flagged.
  expect(answer!.text).toMatch(/Gary Guest 📵 no number on record/);
  expect(answer!.text).toMatch(/Larry Lid 📵 no number on record/);
  expect(answer!.text).not.toMatch(/Pete Power 📵/);
  expect(answer!.text).not.toContain(PHONE_MARKER);
});

test('group "dm me …" → answered PRIVATELY via scoped Q&A, 📩 react, no group reply', async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.post("dan", "@MatchTime dm me when's the next game?");
  expect(r.handledBy).toBe("fast-path");
  expect(r.react).toBe("📩");
  expect(r.reply).toBeNull();
  const danPhone = grp.player("dan").phone!.replace(/^\+/, "");
  const dm = r.dms.find((d) => d.phone === danPhone);
  expect(dm).toBeTruthy();
  expect(dm!.text).toContain("UPCOMING MATCH:");
  expect(dm!.text).not.toContain(PHONE_MARKER); // group→DM context is flag-free too
});

test('"my stats" fast-path → 📊 react + personal magic-link DM, no LLM involved', async ({ request, db }) => {
  const grp = await group(request, db);
  // Interaction contract: a stats request is answer-y → requires a tag.
  const r = await grp.post("pete", "@Match Time can I see my stats?", { tag: true });
  expect(r.handledBy).toBe("fast-path");
  expect(r.intent).toBe("stats_link");
  expect(r.react).toBe("📊");
  const petePhone = grp.player("pete").phone!.replace(/^\+/, "");
  const dm = r.dms.find((d) => d.phone === petePhone);
  expect(dm).toBeTruthy();
  expect(dm!.text).toContain("stats");
  expect(dm!.text).toMatch(/https?:\/\//);
});
