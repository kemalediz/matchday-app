/**
 * Re-stamp every UPCOMING / TEAMS_* match that was created with the
 * old UTC-instead-of-London-local bug. For each such match, we read
 * the Activity.time (wall-clock BST) and rewrite Match.date to the
 * correct UTC instant that represents that London wall clock on the
 * same calendar day the match was stored for.
 *
 * Dry-run by default — pass --apply to actually write.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { londonWallClockToUtc, formatLondon } from "../src/lib/london-time.ts";

async function main() {
  const apply = process.argv.includes("--apply");
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const matches = await db.match.findMany({
    where: { status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] } },
    include: { activity: { select: { name: true, time: true } } },
    orderBy: { date: "asc" },
  });

  console.log(`Found ${matches.length} open match(es). ${apply ? "APPLYING" : "DRY-RUN"}\n`);

  for (const m of matches) {
    const stored = m.date;
    const intendedUtc = londonWallClockToUtc(stored, m.activity.time);
    const diffMs = stored.getTime() - intendedUtc.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);

    const storedLdn = formatLondon(stored, "EEE d MMM HH:mm zzz");
    const intendedLdn = formatLondon(intendedUtc, "EEE d MMM HH:mm zzz");

    if (Math.abs(diffHours) < 1 / 60) {
      console.log(`✅ ${m.activity.name}: already correct (${storedLdn})`);
      continue;
    }

    console.log(`⚠️  ${m.activity.name}:`);
    console.log(`    stored:   ${stored.toISOString()}  → ${storedLdn}`);
    console.log(`    intended: ${intendedUtc.toISOString()}  → ${intendedLdn}`);
    console.log(`    diff:     ${diffHours.toFixed(2)}h off\n`);

    if (apply) {
      const newDeadline = new Date(
        intendedUtc.getTime() - (stored.getTime() - m.attendanceDeadline.getTime()),
      );
      await db.match.update({
        where: { id: m.id },
        data: { date: intendedUtc, attendanceDeadline: newDeadline },
      });
      console.log(`    ✅ updated\n`);
    }
  }

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
