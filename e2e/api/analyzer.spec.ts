/**
 * Analyzer apply-path integration tests — /api/whatsapp/analyze.
 *
 * Each test writes the verdict it wants the "LLM" to return, POSTs a
 * batch the way the Pi bot does, and asserts the deterministic
 * server-side apply path via direct DB reads. No Anthropic call, no
 * WhatsApp send (BotJobs are just rows).
 *
 * Tests are serial and share cumulative state on the UPCOMING match:
 *   start    4/5 confirmed (admin, collector, player, third) + Ben on bench
 *   T1 IN    Ian "in"             → CONFIRMED (5/5)
 *   T2 IN    Zara "in" while full → BENCH
 *   T3 OUT   Pat drops            → DROPPED + open BenchSlotOffer
 *   T4 BENCH admin demotes Tom (registerFor BENCH) → BENCH, slot freed
 *
 * ════════════════════════════════════════════════════════════════════════
 * ⚠️ §10 STEP 8 (2026-09-06): THIS FILE STUBS A DECIDER THAT NO LONGER
 *    EXISTS. SIX OF ITS TESTS ARE EXPECTED TO FAIL; THREE WERE DELETED.
 * ════════════════════════════════════════════════════════════════════════
 *
 * `setLlmStub` wrote the file `analyzeBatch` read. `analyzeBatch`,
 * `SYSTEM_PROMPT`, `AnalysisVerdict` and `executeVerdict` are all
 * deleted, so the stub now changes nothing: the server routes nothing,
 * no owner claims anything, and every assertion below that something was
 * WRITTEN will fail. See `e2e/helpers/stub.ts`'s header for the full
 * account and the list of the ~20 specs in the same position.
 *
 * THE SIX SURVIVING VERDICT TESTS ARE LEFT FAILING, NOT DELETED. Each
 * pins a shipped behaviour of the apply path — capacity, the bench-slot
 * offer, a demote that must not open one, the batch-final squad post,
 * the banter-drop guard — and all six are portable: the same case
 * expressed as a route plus extractor facts, the way
 * `e2e/sim/attendance-engine.spec.ts` now does it. Deleting them to make
 * the suite green would delete the only end-to-end coverage of those
 * paths at the exact moment the layer above them was replaced.
 *
 * ── THE THREE THAT WERE DELETED, AND WHERE EACH IS COVERED NOW ───────
 *
 * These three are NOT portable, because the thing they tested is gone
 * rather than moved. Each asserted a SAFETY NET whose only input was a
 * field on `AnalysisVerdict`, and §10 step 6/8 deleted all three nets
 * from `analyze/route.ts`:
 *
 *   1. "bench-demote SAFETY NET: reply claims the move but registerFor
 *      is empty → server still demotes" (Salman Shelly, 2026-06-11,
 *      9afa357). Input: `verdict.reply`, a prose regex.
 *   2. "OUT safety net must NOT fire on a group-level chase" (Kemal,
 *      2026-05-28). Input: `verdict.reasoning`, a prose regex, in the
 *      over-fire direction.
 *   3. "OUT safety net: replacement_request with no registerAttendance
 *      drops the sender" (Mojib/Habib, 2026-05-26, f35dfe6). Same input,
 *      under-fire direction.
 *
 * COVERED NOW BY `src/lib/__tests__/seatbelt-deletion.test.ts`, which
 * inverts rather than retires: it asserts the three markers are ABSENT
 * from the route, that `executeVerdict` and the verdict types are gone,
 * and — the load-bearing half — that each net's input (`intent`,
 * `reasoning`, `reply`) appears in NO owned route's extractor schema, so
 * the error class cannot be reintroduced silently. It also asserts each
 * of the three incident DATES still has a replayable case in
 * `e2e/corpus/incidents.jsonl`, which is what stops "the incident moved"
 * from becoming "the incident was forgotten". The OUT net's own regex
 * logic remains unit-tested against real production reasoning strings in
 * `src/lib/__tests__/out-safety-net.test.ts`.
 *
 * Restating the tests here against a `setLlmStub` verdict would be
 * asserting that a deleted guard still fires on input nothing can
 * produce — a green tick over nothing, which is the shape this codebase
 * hunts rather than writes.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { setLlmStub } from "../helpers/stub";
import { U, MATCH } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

let n = 0;
const msgId = () => `e2e-analyzer-${Date.now()}-${++n}`;

interface AttendanceRow {
  status: string;
  userId: string;
}

const attendance = (db: TestDb, userId: string) =>
  db.one<AttendanceRow>(
    `SELECT * FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.upcoming, userId],
  );

const confirmedCount = (db: TestDb) =>
  db.count(
    `SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1 AND status = 'CONFIRMED'`,
    [MATCH.upcoming],
  );

test("IN verdict registers the sender as CONFIRMED", async ({ request, db }) => {
  const id = msgId();
  setLlmStub({
    [id]: { intent: "in", registerAttendance: "IN", react: "👍", confidence: 0.95, reasoning: "stub" },
  });
  const res = await postAnalyze(request, [
    { waMessageId: id, body: "Count me in for Tuesday lads", authorPhone: "447700900009", authorName: "Ian Innes" },
  ]);
  const r = res.results.find((x: { waMessageId: string }) => x.waMessageId === id);
  expect(r.handledBy).toBe("llm");
  expect(r.react).toBe("✅"); // server recomputes the react from the real slot

  const att = await attendance(db, U.fresh);
  expect(att?.status).toBe("CONFIRMED");
});

test("IN on a full squad lands on the BENCH", async ({ request, db }) => {
  const id = msgId();
  setLlmStub({
    [id]: { intent: "in", registerAttendance: "IN", react: "👍", confidence: 0.95, reasoning: "stub" },
  });
  const res = await postAnalyze(request, [
    { waMessageId: id, body: "in for tuesday too", authorPhone: "447700900010", authorName: "Zara Zest" },
  ]);
  const r = res.results.find((x: { waMessageId: string }) => x.waMessageId === id);
  expect(r.react).toBe("🪑");

  const att = await attendance(db, U.extra);
  expect(att?.status).toBe("BENCH");
  expect(await confirmedCount(db)).toBe(5); // capacity respected
});

test("OUT verdict drops the sender and opens a bench-slot offer", async ({ request, db }) => {
  const id = msgId();
  setLlmStub({
    [id]: { intent: "out", registerAttendance: "OUT", react: "👋", confidence: 0.95, reasoning: "stub" },
  });
  const res = await postAnalyze(request, [
    { waMessageId: id, body: "Sorry lads, something came up tonight, count me out", authorPhone: "447700900003", authorName: "Pat Player" },
  ]);
  const r = res.results.find((x: { waMessageId: string }) => x.waMessageId === id);
  expect(r.react).toBe("👋");

  const att = await attendance(db, U.player);
  expect(att?.status).toBe("DROPPED");

  // Slot freed + bench non-empty → an OPEN BenchSlotOffer for Pat's slot.
  const offer = await db.one(
    `SELECT * FROM "BenchSlotOffer" WHERE "matchId" = $1 AND "resolvedAt" IS NULL AND "replacingUserId" = $2`,
    [MATCH.upcoming, U.player],
  );
  expect(offer).not.toBeNull();
});

test("third-party BENCH demote: CONFIRMED → BENCH, slot freed, no duplicate", async ({ request, db }) => {
  const before = await confirmedCount(db);
  const id = msgId();
  setLlmStub({
    [id]: {
      intent: "question",
      registerFor: [{ name: "Tom Third", action: "BENCH" }],
      reply: "Done — Tom Third has moved to the bench. A confirmed slot is open.",
      react: "✅",
      confidence: 0.95,
      reasoning: "stub: admin demote",
    },
  });
  const res = await postAnalyze(request, [
    { waMessageId: id, body: "@Match Time move Tom to the bench please", authorPhone: "447700900001", authorName: "Alex Admin", botMentioned: true },
  ]);
  const r = res.results.find((x: { waMessageId: string }) => x.waMessageId === id);
  expect(r.react).toBe("🪑");
  // The reply passes through exactly once, unmodified. This used to be
  // "the safety net must NOT double-announce when registerFor already
  // carries the BENCH entry"; the bench-demote net is deleted (§10 step
  // 6/8), so there is nothing left that could double-announce and the
  // assertion is now simply that a demote's reply is not rewritten.
  expect(r.reply).toContain("Tom Third has moved to the bench");

  const att = await attendance(db, U.third);
  expect(att?.status).toBe("BENCH");
  // Exactly one attendance row for Tom (no duplicate registration).
  const tomRows = await db.count(
    `SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`,
    [MATCH.upcoming, U.third],
  );
  expect(tomRows).toBe(1);
  // Slot freed: confirmed count went DOWN by one.
  expect(await confirmedCount(db)).toBe(before - 1);
  // A demote (unlike a drop) must NOT open a bench-slot offer for Tom.
  const offer = await db.one(
    `SELECT * FROM "BenchSlotOffer" WHERE "matchId" = $1 AND "resolvedAt" IS NULL AND "replacingUserId" = $2`,
    [MATCH.upcoming, U.third],
  );
  expect(offer).toBeNull();
});

test("multiple squad-state replies collapse into ONE batch-final status post", async ({ request, db }) => {
  // ⚠️ THE CUMULATIVE STATE IN THIS COMMENT IS STALE. The bench-demote
  // net's test (deleted §10 step 8 — see the tombstone below) was what
  // put Ian on the bench, so the numbers below no longer describe the
  // world this test runs in. Left as written rather than re-derived,
  // because the whole file needs porting off the dead verdict seam and a
  // corrected count against a decider that does nothing would be a
  // fiction dressed as a fix. Fix the counts as part of the port.
  //
  // State here (as of the version that last ran): 2/5 confirmed (Alex,
  // Colin), bench = Ben + Zara + Tom + Ian, Pat dropped. Two stubbed verdicts both emit contradictory
  // squad-state replies (the Sutton Lads 2026-06-12 failure shape) —
  // the route must silence all but the last and replace it with the
  // deterministic status post computed from the post-batch DB snapshot.
  const idA = msgId();
  const idB = msgId();
  setLlmStub({
    [idA]: { intent: "question", reply: "We're 5/5 — full squad ✅", react: null, confidence: 0.95, reasoning: "stub" },
    [idB]: { intent: "question", reply: "Bench is empty — no standby players.", react: null, confidence: 0.95, reasoning: "stub" },
  });
  const res = await postAnalyze(request, [
    { waMessageId: idA, body: "@Match Time are we full for tuesday?", authorPhone: "447700900001", authorName: "Alex Admin", botMentioned: true },
    { waMessageId: idB, body: "@Match Time who's on the bench?", authorPhone: "447700900002", authorName: "Colin Collector", botMentioned: true },
  ]);
  const rA = res.results.find((x: { waMessageId: string }) => x.waMessageId === idA);
  const rB = res.results.find((x: { waMessageId: string }) => x.waMessageId === idB);
  expect(rA.reply).toBeNull(); // earlier squad-state reply silenced
  expect(rB.reply).toContain("Based on all the messages I've picked up");
  expect(rB.reply).toContain("*2/5*"); // batch-final truth, not the stale stub claims
  expect(rB.reply).toContain("*Playing:*");
  expect(rB.reply).toContain("*Bench (4):*"); // bench shown in the same post
  expect(rB.reply).not.toContain("Bench is empty");

  // No attendance side-effects from question verdicts.
  expect(await confirmedCount(db)).toBe(2);
});

test("banter-drop guard: third-party OUT for a player active in the batch is refused", async ({ request, db }) => {
  // Colin is CONFIRMED and chatting in this very batch; Pat (not an
  // admin) posts banter that the stubbed "LLM" misreads as a real drop
  // (the Zeeshan 2026-06-12 incident). The guard must strip the OUT,
  // keep Colin CONFIRMED, and silence the lying reply.
  const pre = await attendance(db, U.collector);
  expect(pre?.status).toBe("CONFIRMED");

  const idChat = msgId();
  const idBanter = msgId();
  setLlmStub({
    [idChat]: { intent: "noise", react: null, reply: null, confidence: 1, reasoning: "stub" },
    [idBanter]: {
      intent: "out",
      registerFor: [{ name: "Colin", action: "OUT" }],
      reply: "Colin is out 😂 We're 1/5 — need 4 more",
      react: "👋",
      confidence: 0.9,
      reasoning: "stub: banter misread as drop",
    },
  });
  const res = await postAnalyze(request, [
    { waMessageId: idChat, body: "😂😂 never, I'm playing", authorPhone: "447700900002", authorName: "Colin Collector" },
    { waMessageId: idBanter, body: "Colin is out lads 😂😂", authorPhone: "447700900003", authorName: "Pat Player" },
  ]);
  const r = res.results.find((x: { waMessageId: string }) => x.waMessageId === idBanter);
  expect(r.reply).toBeNull(); // never announce a drop we refused to make
  expect(r.react).toBeNull(); // 👋 would imply the drop happened

  const att = await attendance(db, U.collector);
  expect(att?.status).toBe("CONFIRMED"); // Colin untouched
});

// ─── THREE SAFETY-NET TESTS WERE DELETED HERE (§10 step 8, 2026-09-06) ──
//
//   • "bench-demote SAFETY NET: reply claims the move but registerFor is
//      empty → server still demotes"      (Salman Shelly 2026-06-11, 9afa357)
//   • "OUT safety net must NOT fire on a group-level chase"
//                                          (Kemal 2026-05-28, the over-fire
//                                           direction and why `notDropping`
//                                           existed)
//   • "OUT safety net: replacement_request with no registerAttendance drops
//      the sender"                         (Mojib/Habib 2026-05-26, f35dfe6)
//
//   All three drove a prose regex over a field on `AnalysisVerdict`
//   (`reply`, `reasoning`) and all three nets are deleted from
//   `analyze/route.ts`. The file header carries the full argument and
//   names where each is covered now:
//   `src/lib/__tests__/seatbelt-deletion.test.ts` (the nets are gone AND
//   their inputs are unrepresentable in every owned route's extractor
//   schema, AND each incident date still has a case in
//   `e2e/corpus/incidents.jsonl`), plus
//   `src/lib/__tests__/out-safety-net.test.ts` for the OUT regex itself.
//
//   THE DELETION IS NOT "the incident stopped mattering". It is "the
//   input the guard read cannot be produced any more": one `polarity`
//   per claim cannot contradict itself, and no schema has a `reasoning`
//   or a `reply` field for a regex to parse.

test("duplicate waMessageId is deduped (bot retry safety)", async ({ request }) => {
  const id = msgId();
  setLlmStub({
    [id]: { intent: "noise", react: null, reply: null, confidence: 1, reasoning: "stub" },
  });
  const body = { waMessageId: id, body: "noise message", authorPhone: "447700900001", authorName: "Alex Admin" as string | null };
  await postAnalyze(request, [body]);
  const second = await postAnalyze(request, [body]);
  const r = second.results.find((x: { waMessageId: string }) => x.waMessageId === id);
  expect(r.handledBy).toBe("deduped");
});
