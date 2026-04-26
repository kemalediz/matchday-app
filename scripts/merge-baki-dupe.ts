import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
/** Merge ghost "Baki" into the original "Baki Sutton". */
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  const ghost = await db.user.findUnique({ where: { id: "cmofljctg000304jp3nym4pz7" } });
  const real = await db.user.findUnique({ where: { id: "cmo4wnnkt0005mvr8vrxko4ck" } });
  if (!ghost || !real) throw new Error("missing user");
  const orgId = "cmnnwhdx30000zfr85q18lyy9";

  // Re-attribute the ghost's attendance to the real user — but only if
  // there's no clash on the (matchId, userId) unique constraint.
  const ghostAtts = await db.attendance.findMany({ where: { userId: ghost.id } });
  for (const a of ghostAtts) {
    const existing = await db.attendance.findUnique({
      where: { matchId_userId: { matchId: a.matchId, userId: real.id } },
    });
    if (existing) {
      console.log(`  Real user already has attendance for match ${a.matchId} — deleting ghost row`);
      await db.attendance.delete({ where: { id: a.id } });
    } else {
      await db.attendance.update({ where: { id: a.id }, data: { userId: real.id } });
      console.log(`  Re-attributed attendance ${a.id} to ${real.id}`);
    }
  }

  // Re-attribute analyzed messages.
  const upd = await db.analyzedMessage.updateMany({
    where: { authorUserId: ghost.id },
    data: { authorUserId: real.id },
  });
  console.log(`  Re-attributed ${upd.count} AnalyzedMessage rows`);

  // Restore the real user's membership.
  await db.membership.update({
    where: { userId_orgId: { userId: real.id, orgId } },
    data: { leftAt: null, provisionallyAddedAt: null },
  });
  console.log(`  Restored ${real.name}'s membership (leftAt=null)`);

  // Delete the ghost membership + user.
  await db.membership.deleteMany({ where: { userId: ghost.id } });
  await db.user.delete({ where: { id: ghost.id } });
  console.log(`  Deleted ghost user ${ghost.id}`);

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
