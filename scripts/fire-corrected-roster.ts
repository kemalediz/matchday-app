/**
 * One-off: ask the server-side analyser to compose a daily-in-list
 * chase using the new (post-fix) prompt, then queue it as a group
 * BotJob so the bot posts the corrected "12/14, 2 on standby, still
 * chasing 2" message — undoing the earlier confusing "14/14 ✅"
 * reply.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const COMPOSE_URL = "https://matchtime.ai/api/whatsapp/compose";
const GROUP_ID = "447525334985-1607872139@g.us";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const apiKey = process.env.WHATSAPP_API_KEY;
  if (!apiKey) throw new Error("WHATSAPP_API_KEY missing");

  // There's no public compose endpoint right now — we call the same
  // analyze entry point with a synthetic question the admin would ask.
  // That forces Claude into the "question" branch, which emits a
  // roster-formatted reply grounded in the current Match Context.
  const analyzeRes = await fetch("https://matchtime.ai/api/whatsapp/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      groupId: GROUP_ID,
      history: [],
      messages: [
        {
          waMessageId: `corrected-roster-${Date.now()}`,
          body: "@M Time please list the squad and tentatives again, clean format",
          authorPhone: "+447930283213", // Kemal (admin)
          authorName: "Kemal",
          timestamp: new Date().toISOString(),
        },
      ],
    }),
  });
  const text = await analyzeRes.text();
  if (!analyzeRes.ok) {
    console.error(`analyze failed ${analyzeRes.status}: ${text}`);
    process.exit(1);
  }
  const json = JSON.parse(text) as {
    results: Array<{ reply: string | null; intent: string; reasoning?: string }>;
  };
  const r = json.results[0];
  console.log(`Intent: ${r.intent}`);
  console.log(`Reasoning: ${r.reasoning ?? "-"}`);
  console.log(`\nReply:\n${r.reply ?? "(no reply)"}`);

  if (!r.reply) {
    console.log("\nClaude didn't emit a reply — nothing to post.");
    await db.$disconnect();
    return;
  }

  // Queue the reply as a group BotJob.
  const org = await db.organisation.findFirst({ where: { whatsappGroupId: GROUP_ID } });
  if (!org) throw new Error("org not found");
  const job = await db.botJob.create({
    data: { orgId: org.id, kind: "group", phone: null, text: r.reply },
  });
  console.log(`\nQueued BotJob ${job.id} — bot posts within ~5 min.`);

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
