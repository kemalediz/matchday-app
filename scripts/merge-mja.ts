import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  const REAL = "cmoacpu36000004kvlrzvuouu"; // original (soft-removed Apr 24)
  const GHOST = "cmoflj9nr000104jpx009f522"; // dupe from today

  const ghostAtts = await db.attendance.findMany({ where: { userId: GHOST } });
  for (const a of ghostAtts) {
    const existing = await db.attendance.findUnique({
      where: { matchId_userId: { matchId: a.matchId, userId: REAL } },
    });
    if (existing) {
      await db.attendance.delete({ where: { id: a.id } });
      console.log(`  deleted ghost attendance ${a.id} (real had it)`);
    } else {
      await db.attendance.update({ where: { id: a.id }, data: { userId: REAL } });
      console.log(`  re-attributed attendance ${a.id} to REAL`);
    }
  }
  const upd = await db.analyzedMessage.updateMany({
    where: { authorUserId: GHOST },
    data: { authorUserId: REAL },
  });
  console.log(`  re-attributed ${upd.count} analyzed messages`);

  // Restore the original membership but keep them flagged as provisional
  // for review since Kemal didn't recognise the name.
  await db.membership.updateMany({
    where: { userId: REAL },
    data: { leftAt: null, provisionallyAddedAt: new Date() },
  });
  console.log(`  restored REAL membership, kept as provisional for review`);

  await db.membership.deleteMany({ where: { userId: GHOST } });
  await db.user.delete({ where: { id: GHOST } });
  console.log(`  deleted ghost user ${GHOST}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
