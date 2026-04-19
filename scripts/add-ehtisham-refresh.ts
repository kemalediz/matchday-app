/**
 * Add Ehtisham to the real Tuesday match's attendance as CONFIRMED,
 * then delete today's daily-in-list SentNotification so the bot
 * re-posts with the correct "need 2 more" count on its next tick.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const match = await db.match.findFirst({
    where: {
      date: { gte: new Date() },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
    },
    orderBy: { date: "asc" },
    include: { activity: { select: { name: true } } },
  });
  if (!match) throw new Error("No upcoming match");

  const user = await db.user.findFirst({
    where: { name: { contains: "Ehtisham", mode: "insensitive" } },
  });
  if (!user) throw new Error("Ehtisham user not found");

  const maxPos = await db.attendance.aggregate({
    where: { matchId: match.id },
    _max: { position: true },
  });
  const nextPosition = (maxPos._max.position ?? 0) + 1;

  const confirmedCount = await db.attendance.count({
    where: { matchId: match.id, status: "CONFIRMED" },
  });
  const status = confirmedCount < match.maxPlayers ? "CONFIRMED" : "BENCH";

  await db.attendance.upsert({
    where: { matchId_userId: { matchId: match.id, userId: user.id } },
    create: {
      matchId: match.id,
      userId: user.id,
      status,
      position: nextPosition,
    },
    update: { status, respondedAt: new Date() },
  });
  console.log(`  ✓  ${user.name} → ${status} (pos ${nextPosition}) on ${match.activity.name}`);

  const reset = await db.sentNotification.deleteMany({
    where: { key: { contains: "daily-in-list" } },
  });
  console.log(`Deleted ${reset.count} daily-in-list key(s). Next bot tick (<5 min) re-posts with correct count.`);

  await db.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
