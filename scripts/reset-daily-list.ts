/**
 * Reset today's daily-in-list SentNotification so the scheduler's next
 * tick re-posts the updated IN list (with the now-correct attendance).
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);
  const res = await db.sentNotification.deleteMany({
    where: { key: { contains: "daily-in-list" } },
  });
  console.log(`Deleted ${res.count} daily-in-list notification(s). Next bot tick will repost.`);
  await db.$disconnect();
}
main();
