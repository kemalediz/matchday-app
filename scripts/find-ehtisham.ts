import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const user = await db.user.findFirst({
    where: { name: { contains: "Ehtisham", mode: "insensitive" } },
    select: { id: true, name: true, email: true, phoneNumber: true },
  });
  console.log("Ehtisham user:", user);

  if (user) {
    const att = await db.attendance.findMany({
      where: { userId: user.id },
      select: { matchId: true, status: true, position: true, respondedAt: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    console.log("Ehtisham attendance rows:", att);
  }

  const match = await db.match.findFirst({
    where: { status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] } },
    orderBy: { date: "asc" },
    select: { id: true, maxPlayers: true },
  });
  if (match) {
    const all = await db.attendance.findMany({
      where: { matchId: match.id },
      include: { user: { select: { name: true } } },
      orderBy: { position: "asc" },
    });
    console.log(`\nMatch ${match.id} ALL attendances (${all.length} rows):`);
    for (const a of all) {
      console.log(`  pos ${a.position}  ${a.user.name}  [${a.status}]`);
    }
  }
  await db.$disconnect();
}
main();
