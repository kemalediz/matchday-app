/**
 * Emergency: delete any un-sent group BotJob in Sutton's queue so the
 * bot doesn't post a now-cancelled corrected-roster message. Called
 * when a fire script ran but the user changed their mind before the
 * bot's 5-min poll picked it up.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const GROUP_ID = "447525334985-1607872139@g.us";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const org = await db.organisation.findFirst({ where: { whatsappGroupId: GROUP_ID } });
  if (!org) throw new Error("org not found");

  const unsent = await db.botJob.findMany({
    where: { orgId: org.id, sentAt: null, kind: "group" },
    orderBy: { createdAt: "desc" },
  });
  console.log(`Found ${unsent.length} unsent group BotJob(s) for ${org.name}`);
  for (const j of unsent) {
    console.log(`  ${j.id}  ${j.createdAt.toISOString()}  "${j.text.slice(0, 80)}..."`);
  }

  if (unsent.length === 0) {
    console.log("Nothing to delete.");
    await db.$disconnect();
    return;
  }

  const del = await db.botJob.deleteMany({
    where: { id: { in: unsent.map((j) => j.id) } },
  });
  console.log(`\nDeleted ${del.count} BotJob(s).`);

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
