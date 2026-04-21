import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const tests = await db.match.findMany({
    where: {
      OR: [
        { activity: { name: { contains: "TEST" } } },
        { activity: { name: { contains: "Rating preview" } } },
      ],
    },
    include: {
      activity: { select: { id: true, name: true, isActive: true } },
      _count: { select: { attendances: true, ratings: true, momVotes: true } },
    },
  });
  console.log(`Found ${tests.length} test matches:`);
  for (const m of tests) {
    console.log(
      `  ${m.id}  ${m.activity.name}  date=${m.date.toISOString()}  att=${m._count.attendances} ratings=${m._count.ratings} moms=${m._count.momVotes}  activeActivity=${m.activity.isActive}`,
    );
  }

  for (const m of tests) {
    await db.match.delete({ where: { id: m.id } });
    console.log(`🗑  deleted ${m.id}`);
  }

  const testActivities = await db.activity.findMany({
    where: { OR: [{ name: { contains: "TEST" } }, { name: { contains: "Rating preview" } }] },
    select: { id: true, name: true, _count: { select: { matches: true } } },
  });
  for (const a of testActivities) {
    if (a._count.matches === 0) {
      await db.activity.delete({ where: { id: a.id } });
      console.log(`🗑  deleted activity ${a.name}`);
    }
  }

  const topByMoM = await db.moMVote.groupBy({
    by: ["playerId"],
    _count: { _all: true },
    orderBy: { _count: { playerId: "desc" } },
    take: 12,
  });
  const ids = topByMoM.map((r) => r.playerId);
  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  console.log(`\nTop MoM after cleanup:`);
  for (const r of topByMoM) {
    const u = users.find((u) => u.id === r.playerId);
    console.log(`  ${r._count._all}  ${u?.name ?? r.playerId}`);
  }

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
