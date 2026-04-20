/**
 * One-off: mark Ibrahim as DROPPED on Tuesday's match. The analyze
 * endpoint correctly identified his message as a replacement_request
 * but couldn't flip the attendance because the phone lookup (without
 * the '+' prefix) missed. Fix is shipped; this just finishes the
 * job for the current match.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const user = await db.user.findFirst({
    where: { name: { startsWith: "Ibrahim" } },
    select: { id: true, name: true },
  });
  if (!user) throw new Error("Ibrahim not found");

  const match = await db.match.findFirst({
    where: {
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
      attendanceDeadline: { gt: new Date() },
      attendances: { some: { userId: user.id } },
    },
    orderBy: { date: "asc" },
    select: { id: true, activity: { select: { name: true } } },
  });
  if (!match) throw new Error("Ibrahim has no upcoming attendance");

  const before = await db.attendance.findUnique({
    where: { matchId_userId: { matchId: match.id, userId: user.id } },
  });
  console.log(`${user.name} on ${match.activity.name}: ${before?.status}`);

  const updated = await db.attendance.update({
    where: { matchId_userId: { matchId: match.id, userId: user.id } },
    data: { status: "DROPPED" },
  });
  console.log(`→ ${updated.status}`);

  const confirmed = await db.attendance.count({
    where: { matchId: match.id, status: "CONFIRMED" },
  });
  console.log(`\nConfirmed now: ${confirmed}`);

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
