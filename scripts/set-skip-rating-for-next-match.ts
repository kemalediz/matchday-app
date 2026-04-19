/**
 * One-off: mark the upcoming Apr 21 Tuesday match so the bot skips the
 * match-end flow (payment poll, rating-link DMs, MoM announcement,
 * rating reminders). Lets us run the first match without the
 * rating-related posts while the rating UI is still being built.
 *
 * From the match after this one onwards, postMatchEndFlow defaults to
 * true so the full rating flow kicks in automatically.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const upcoming = await db.match.findMany({
    where: {
      date: { gte: new Date() },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
    },
    include: { activity: { select: { name: true, orgId: true } } },
    orderBy: { date: "asc" },
    take: 1,
  });

  if (upcoming.length === 0) {
    console.log("No upcoming matches to mark.");
    await db.$disconnect();
    return;
  }

  const m = upcoming[0];
  await db.match.update({
    where: { id: m.id },
    data: { postMatchEndFlow: false },
  });
  console.log(`Disabled post-match-end flow for ${m.activity.name} on ${m.date.toISOString()}.`);
  console.log(`Match id: ${m.id}`);
  console.log("From the next match onwards, postMatchEndFlow defaults to true (rating flow enabled).");

  await db.$disconnect();
}

main();
