/**
 * Suppress every automated group post scheduled for today (London
 * time) by pre-emptively inserting the matching SentNotification
 * idempotency rows. The scheduler checks these keys before emitting
 * an instruction — a row already present means "already sent" and the
 * post is skipped.
 *
 * Called to pause the 5pm daily-in-list and any other Monday posts
 * while we overhaul the message-analysis pipeline.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  // London date key (YYYY-MM-DD).
  const dayKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  // Find every UPCOMING / TEAMS_* match in any org (scoped to Sutton FC
  // for now — there's only one).
  const matches = await db.match.findMany({
    where: {
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
    },
    include: { activity: { select: { name: true, orgId: true } } },
  });

  console.log(`Today's London date key: ${dayKey}`);
  console.log(`Found ${matches.length} open match(es)\n`);

  const keysToBlock: string[] = [];
  for (const m of matches) {
    // The 5pm daily-in-list is the only GROUP post tied to a dayKey.
    keysToBlock.push(`${m.id}:daily-in-list:${dayKey}`);
  }

  for (const key of keysToBlock) {
    const existing = await db.sentNotification.findUnique({ where: { key } });
    if (existing) {
      console.log(`🟢 already suppressed: ${key}`);
      continue;
    }
    await db.sentNotification.create({
      data: {
        key,
        kind: "daily-in-list",
        matchId: key.split(":")[0],
      },
    });
    console.log(`✅ suppressed: ${key}`);
  }

  // Also list what's still scheduled for the next 24h (informational).
  console.log(`\n--- Upcoming scheduled events (not suppressed) ---`);
  for (const m of matches) {
    console.log(`Match ${m.activity.name} on ${m.date.toISOString()}:`);
    console.log(`  - bench-prompt: fires if anyone drops + a bench player exists`);
    console.log(`  - switch-nudge (admin DM): 10-11am London, day before`);
    console.log(`  - cancel-nudge (admin DM): 18-19pm London, day before (today!) — only if below min viable`);
    console.log(`  - teams-morning: match day 8-11am`);
    console.log(`  - pre-kickoff: 2h before kickoff`);
  }

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
