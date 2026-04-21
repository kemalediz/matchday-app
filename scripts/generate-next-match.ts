/**
 * One-off: mirror the /api/cron/generate-matches logic to create any
 * missing next-week Match rows right now (rather than waiting for the
 * next cron tick). Uses the same helpers so the result is identical
 * to what the cron would produce.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { londonWallClockToUtc, formatLondon } from "../src/lib/london-time.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const activities = await db.activity.findMany({
    where: { isActive: true },
    include: { sport: true },
  });

  let created = 0;
  for (const activity of activities) {
    const now = new Date();
    const londonWeekday = Number(formatLondon(now, "i")) % 7;
    let daysUntil = activity.dayOfWeek - londonWeekday;
    if (daysUntil <= 0) daysUntil += 7;

    const todayLondonMidnight = londonWallClockToUtc(now, "00:00");
    const anchor = new Date(todayLondonMidnight.getTime() + daysUntil * 24 * 60 * 60 * 1000);
    const matchDate = londonWallClockToUtc(anchor, activity.time);

    const dayStart = new Date(matchDate.getTime() - 12 * 60 * 60 * 1000);
    const dayEnd = new Date(matchDate.getTime() + 12 * 60 * 60 * 1000);
    const existing = await db.match.findFirst({
      where: { activityId: activity.id, date: { gte: dayStart, lte: dayEnd } },
    });
    if (existing) {
      console.log(
        `⏭  ${activity.name}: already have a match at ${existing.date.toISOString()} — skipping`,
      );
      continue;
    }

    const deadline = new Date(matchDate.getTime() - activity.deadlineHours * 60 * 60 * 1000);
    const m = await db.match.create({
      data: {
        activityId: activity.id,
        date: matchDate,
        maxPlayers: activity.sport.playersPerTeam * 2,
        attendanceDeadline: deadline,
      },
    });
    console.log(
      `✅ ${activity.name}: created match ${m.id} at ${matchDate.toISOString()} ` +
        `(${formatLondon(matchDate, "EEE d MMM HH:mm")})`,
    );
    created++;
  }

  console.log(`\nDone. Created ${created} match(es).`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
