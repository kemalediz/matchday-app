/**
 * Peek at ratings + MoM votes Kemal has cast on the test match so we
 * can confirm the rating page field-test landed correctly.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const MATCH_ID = "cmo60nrsz0000txr8r1q732is"; // [TEST] Rating preview
const KEMAL_EMAIL = "kemal.ediz@cressoft.io";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const match = await db.match.findUnique({
    where: { id: MATCH_ID },
    include: { activity: { select: { name: true } } },
  });
  if (!match) throw new Error("test match not found");

  const kemal = await db.user.findUnique({
    where: { email: KEMAL_EMAIL },
    select: { id: true, name: true },
  });
  if (!kemal) throw new Error("Kemal not found");

  console.log(`Match:  ${match.activity.name} (${MATCH_ID})`);
  console.log(`Rater:  ${kemal.name} (${kemal.id})\n`);

  const ratings = await db.rating.findMany({
    where: { matchId: MATCH_ID, raterId: kemal.id },
    include: { player: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  console.log(`=== Ratings cast by Kemal: ${ratings.length} ===`);
  for (const r of ratings) {
    console.log(`  ${r.score.toString().padStart(2)} → ${r.player.name ?? "(unnamed)"} ` +
      `@ ${r.createdAt.toISOString()}`);
  }

  const mom = await db.moMVote.findFirst({
    where: { matchId: MATCH_ID, voterId: kemal.id },
    include: { player: { select: { name: true } } },
  });
  console.log(`\n=== MoM vote by Kemal ===`);
  if (!mom) {
    console.log("  (none)");
  } else {
    console.log(`  ${mom.player.name ?? "(unnamed)"} @ ${mom.createdAt.toISOString()}`);
  }

  // Full tallies for context.
  const allRatings = await db.rating.count({ where: { matchId: MATCH_ID } });
  const allMom = await db.moMVote.count({ where: { matchId: MATCH_ID } });
  console.log(`\nMatch totals: ${allRatings} ratings, ${allMom} MoM votes`);

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
