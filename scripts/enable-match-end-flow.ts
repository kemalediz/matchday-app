/**
 * Flip Match.postMatchEndFlow back to true for the next upcoming match
 * so the bot runs the full rating/MoM/payment flow after it finishes.
 * (We had it disabled while the rating UI was being built.)
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
  if (!match) {
    console.log("No upcoming match found.");
    return;
  }

  await db.match.update({
    where: { id: match.id },
    data: { postMatchEndFlow: true },
  });

  console.log(
    `Re-enabled post-match-end flow for ${match.activity.name} on ${match.date.toISOString()}.`,
  );
  console.log("After the match ends on Apr 21 the bot will:");
  console.log("  1) Ask for the score 1h after end");
  console.log("  2) Post payment poll (Red/Yellow)");
  console.log("  3) Post MoM WhatsApp poll (confirmed players)");
  console.log("  4) DM each confirmed player a personal rating magic link");
  console.log("  5) Post a group promo message about the DMs");
  console.log("  6) DM reminders at 18:00 daily for non-voters (up to 5 days)");
  console.log("  7) Announce MoM in the group 5 days after the match at 15:00");

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
