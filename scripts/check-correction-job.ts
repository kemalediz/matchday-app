import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);
  const id = "cmohbk2kt0000pfr81bckv4qk";
  const job = await db.botJob.findUnique({ where: { id } });
  console.log("BotJob:", { id: job?.id, sentAt: job?.sentAt, createdAt: job?.createdAt });

  const sn = await db.sentNotification.findUnique({ where: { key: `botjob-${id}` } });
  console.log("SentNotification:", sn);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => process.exit(0));
