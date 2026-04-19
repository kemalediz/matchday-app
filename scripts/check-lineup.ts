import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);
  const match = await db.match.findFirst({
    where: { date: { gte: new Date() } },
    orderBy: { date: "asc" },
    include: {
      activity: { select: { name: true } },
      attendances: {
        where: { status: { in: ["CONFIRMED", "BENCH"] } },
        include: { user: { select: { name: true } } },
        orderBy: { position: "asc" },
      },
    },
  });
  if (!match) return;
  console.log(`${match.activity.name} · ${match.attendances.length}/${match.maxPlayers} taken · ${match.date.toISOString()}`);
  for (const a of match.attendances) {
    console.log(`  ${a.position}. ${a.user.name} [${a.status}]`);
  }
  await db.$disconnect();
}
main();
