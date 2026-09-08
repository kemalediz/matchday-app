/**
 * @-MENTION NAMING, end to end through `/api/whatsapp/analyze`.
 *
 * The Pi no longer pastes a contact's pushname into the message body (see
 * `whatsapp-bot/src/mentions.ts`): it forwards the raw "@<digits>" token,
 * the mention JIDs, and — as clearly-untrusted structured data — the
 * display name it saw. This spec pins what the SERVER then does with
 * that, at the seam the Pi actually posts to.
 *
 * The two failures being fixed are real, from the live Sutton FC group:
 *
 *   "@Shahrokh🐔 Sutton Football Club is out due to unforeseen issue at work"
 *   reached the analyzer as "@DÇ  is out …"        → routed noise, drop lost
 *
 *   "@David David 67 and @~Najib out"
 *   reached it as "@割::::.̸̢̤̋…  and @Najib out"  → drop lost
 *
 * Neither string was corrupt: both are the mentioned person's own
 * WhatsApp pushname. The club's database knew better in both directions —
 * one is a phone number away, the other already had a curated
 * `UserAlias`. So the naming belongs here, where the roster is.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { NAME, ORG_ID, PHONE, U } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

let n = 0;
const msgId = () => `e2e-mention-${Date.now()}-${++n}`;

const storedBody = (db: TestDb, waMessageId: string) =>
  db.one<{ body: string }>(`SELECT body FROM "AnalyzedMessage" WHERE "waMessageId" = $1`, [
    waMessageId,
  ]);

test("a @c.us mention is named from the roster PHONE, with no name supplied at all", async ({
  request,
  db,
}) => {
  const id = msgId();
  // The strongest path: the mention JID IS Tom's phone number. Nothing
  // was looked up on the Pi and nothing the mentioned person controls.
  await postAnalyze(request, [
    {
      waMessageId: id,
      body: "@447700900008 is out due to unforeseen issue at work",
      authorPhone: "447700900001",
      authorName: NAME.admin,
      mentions: ["447700900008@c.us"],
    },
  ]);
  const row = await storedBody(db, id);
  expect(row?.body).toBe(`@${NAME.third} is out due to unforeseen issue at work`);
});

test("an @lid mention is named from an admin-curated UserAlias (the David case)", async ({
  request,
  db,
}) => {
  // Exactly the live shape: an opaque @lid mention whose only clue is a
  // pushname nobody would recognise — and which an admin has already
  // mapped to the real member.
  await db.run(
    `INSERT INTO "UserAlias" (id, "userId", "orgId", alias, source, "createdAt")
     VALUES ($1, $2, $3, $4, 'manual', NOW()) ON CONFLICT DO NOTHING`,
    ["e2e-alias-mention", U.player, ORG_ID, "割::::.."],
  );
  const id = msgId();
  await postAnalyze(request, [
    {
      waMessageId: id,
      body: "@233452997767322 and @447700900008 out",
      authorPhone: "447700900001",
      authorName: NAME.admin,
      mentions: ["233452997767322@lid", "447700900008@c.us"],
      mentionNames: [{ jid: "233452997767322@lid", name: "割::::.." }],
    },
  ]);
  const row = await storedBody(db, id);
  expect(row?.body).toBe(`@${NAME.player} and @${NAME.third} out`);
});

test("an unresolvable mention keeps its raw token — no name is invented", async ({
  request,
  db,
}) => {
  // "DÇ" is Shahrokh's pushname. It matches no member and has no alias,
  // so nothing may be substituted. The old Pi pasted it and the drop was
  // read as noise.
  const id = msgId();
  await postAnalyze(request, [
    {
      waMessageId: id,
      body: "@158055467598020 is out due to unforeseen issue at work",
      authorPhone: "447700900001",
      authorName: NAME.admin,
      mentions: ["158055467598020@lid"],
      mentionNames: [{ jid: "158055467598020@lid", name: "DÇ" }],
    },
  ]);
  const row = await storedBody(db, id);
  expect(row?.body).toBe("@158055467598020 is out due to unforeseen issue at work");
  expect(row?.body).not.toContain("DÇ");
});

test("ambiguity bails: two Omars means the token stays raw", async ({ request, db }) => {
  const id = msgId();
  await postAnalyze(request, [
    {
      waMessageId: id,
      body: "@233452997767999 out",
      authorPhone: "447700900001",
      authorName: NAME.admin,
      mentions: ["233452997767999@lid"],
      mentionNames: [{ jid: "233452997767999@lid", name: "Omar" }],
    },
  ]);
  const row = await storedBody(db, id);
  expect(row?.body).toBe("@233452997767999 out");
});

test("OLD PI: a pre-substituted body with no mentionNames is left exactly as it arrived", async ({
  request,
  db,
}) => {
  // The server ships before the Pi does (Vercel on merge; the Pi by hand).
  // An old Pi sends a body it already rewrote and no `mentionNames`; the
  // new code must be a no-op on it, not a second pass.
  const id = msgId();
  const body = `@${NAME.third} and @Someone Else out`;
  await postAnalyze(request, [
    {
      waMessageId: id,
      body,
      authorPhone: "447700900001",
      authorName: NAME.admin,
      mentions: ["447700900008@c.us", "233452997767322@lid"],
    },
  ]);
  const row = await storedBody(db, id);
  expect(row?.body).toBe(body);
});

test("a message with no mentions is untouched", async ({ request, db }) => {
  const id = msgId();
  await postAnalyze(request, [
    {
      waMessageId: id,
      body: "who else is around on tuesday?",
      authorPhone: PHONE.admin.replace("+", ""),
      authorName: NAME.admin,
    },
  ]);
  const row = await storedBody(db, id);
  expect(row?.body).toBe("who else is around on tuesday?");
});
