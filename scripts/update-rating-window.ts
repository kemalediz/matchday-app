/**
 * One-off: existing activities were seeded with ratingWindowHours=48.
 * Bump to 120 so the rating window aligns with the 5-day MoM
 * announcement and magic-link TTL.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);
  const res = await db.activity.updateMany({
    where: { ratingWindowHours: 48 },
    data: { ratingWindowHours: 120 },
  });
  console.log(`Bumped ratingWindowHours 48 → 120 on ${res.count} activities`);
  await db.$disconnect();
}
main();
