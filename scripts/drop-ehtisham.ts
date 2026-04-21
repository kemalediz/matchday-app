/**
 * Mark Ehtisham as DROPPED for the current Tuesday match. He confirmed
 * in chat that he's out. Also print the current squad + any smaller-
 * format Sport/Activity on the org so we know whether the LLM can
 * suggest a 5-a-side switch.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const ehtisham = await db.user.findFirst({
    where: { name: { startsWith: "Ehtisham" } },
    select: { id: true, name: true },
  });
  if (!ehtisham) throw new Error("Ehtisham not found");

  const match = await db.match.findFirst({
    where: {
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
      attendanceDeadline: { gt: new Date() },
      attendances: { some: { userId: ehtisham.id } },
    },
    include: { activity: { include: { sport: true, org: true } } },
    orderBy: { date: "asc" },
  });
  if (!match) throw new Error("Ehtisham has no upcoming match attendance");

  console.log(`Match: ${match.activity.name} at ${match.date.toISOString()}`);

  const before = await db.attendance.findUnique({
    where: { matchId_userId: { matchId: match.id, userId: ehtisham.id } },
  });
  console.log(`${ehtisham.name}: ${before?.status} → DROPPED`);

  await db.attendance.update({
    where: { matchId_userId: { matchId: match.id, userId: ehtisham.id } },
    data: { status: "DROPPED" },
  });

  const confirmed = await db.attendance.count({
    where: { matchId: match.id, status: "CONFIRMED" },
  });
  console.log(`\nConfirmed: ${confirmed}/${match.maxPlayers} (need ${match.maxPlayers - confirmed})`);

  // Look up any smaller-format activities in the same sport family for
  // this org — that's what the LLM would propose as a switch.
  const orgId = match.activity.orgId;
  const family = match.activity.sport.name.split(" ")[0];
  const others = await db.activity.findMany({
    where: { orgId },
    include: { sport: true },
  });
  const smaller = others.filter(
    (a) =>
      a.sport.name.split(" ")[0] === family &&
      a.sport.playersPerTeam < match.activity.sport.playersPerTeam,
  );
  console.log(`\nSport family: "${family}"`);
  console.log(`Same-family activities for switch options:`);
  for (const a of others.filter((a) => a.sport.name.split(" ")[0] === family)) {
    const marker = a.id === match.activityId ? "   ← current" : "";
    console.log(
      `  ${a.sport.name}  (${a.sport.playersPerTeam * 2} players, isActive=${a.isActive})${marker}`,
    );
  }
  console.log(`\nSmaller formats available: ${smaller.length}`);

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
