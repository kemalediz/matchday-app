/**
 * One-off: re-feed Ehtisham's 10:30 message through the smart analyser.
 * It was sent while the bot was running the pre-regex-removal code
 * (which bailed on @lid senders), then the catch-up scan failed
 * because wweb.js's fetchMessages is broken on this session — so the
 * LLM never got to see it.
 *
 * This script pushes it through /api/whatsapp/analyze directly. If the
 * LLM generates a reply, we queue it as a BotJob so the bot posts it
 * to the group on its next scheduler tick (≤5 min).
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const ANALYZE_URL = "https://matchtime.ai/api/whatsapp/analyze";
const GROUP_ID = "447525334985-1607872139@g.us";
const EHTISHAM_PHONE = "+447869720100"; // from DB, per earlier lookups
const BODY = `Anyone else who can replace me too
If not
I will still
Join
Just caught with temp this morning
But if no one comes I will Join to make up numbers`;

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const apiKey = process.env.WHATSAPP_API_KEY;
  if (!apiKey) throw new Error("WHATSAPP_API_KEY not in env");

  // Look up Ehtisham's real phone from DB for accuracy.
  const user = await db.user.findFirst({
    where: { name: { startsWith: "Ehtisham" } },
    select: { id: true, name: true, phoneNumber: true },
  });
  const phone = user?.phoneNumber ?? EHTISHAM_PHONE;
  console.log(`Ehtisham: ${user?.name} ${phone}`);

  const body = {
    groupId: GROUP_ID,
    history: [],
    messages: [
      {
        waMessageId: `manual-ehtisham-tentative-${Date.now()}`,
        body: BODY,
        authorPhone: phone,
        authorName: user?.name ?? "Ehtisham Ul Haq",
        timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      },
    ],
  };

  const res = await fetch(ANALYZE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`Status ${res.status}`);
  console.log(text);

  if (!res.ok) process.exit(1);

  const json = JSON.parse(text) as {
    results: Array<{ intent: string; reply: string | null; react: string | null }>;
  };
  const r = json.results[0];
  if (!r) { console.log("no result"); return; }
  console.log(`\nIntent: ${r.intent}  react=${r.react ?? "-"}  reply=${r.reply ?? "-"}`);

  // Queue the reply as a BotJob so the bot posts it in the group.
  if (r.reply) {
    const org = await db.organisation.findFirst({ where: { whatsappGroupId: GROUP_ID } });
    if (!org) throw new Error("org not found");
    const job = await db.botJob.create({
      data: { orgId: org.id, kind: "group", phone: null, text: r.reply },
    });
    console.log(`\nQueued BotJob ${job.id} — bot will post within ~5 min.`);
  }

  // Confirm attendance is untouched (tentative replacement_request should NOT flip).
  if (user) {
    const att = await db.attendance.findFirst({
      where: {
        userId: user.id,
        match: {
          status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
          attendanceDeadline: { gt: new Date() },
        },
      },
      include: { match: { select: { id: true } } },
      orderBy: { createdAt: "desc" },
    });
    console.log(`\nEhtisham attendance: ${att?.status ?? "(none)"}`);
  }

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
