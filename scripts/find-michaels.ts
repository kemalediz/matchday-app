import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  const all = await db.user.findMany({
    where: { name: { contains: "Michael", mode: "insensitive" } },
    include: {
      memberships: { include: { org: { select: { name: true } } } },
      _count: { select: { attendances: true, ratingsGiven: true, ratingsReceived: true } },
    },
  });
  for (const u of all) {
    console.log(`\n${u.id}  name="${u.name}"  phone=${u.phoneNumber}  email=${u.email}`);
    console.log(`  attendance=${u._count.attendances}  ratingsGiven=${u._count.ratingsGiven}  ratingsReceived=${u._count.ratingsReceived}`);
    console.log(`  seedRating=${u.seedRating}  matchRating=${u.matchRating}  createdAt=${u.createdAt.toISOString()}`);
    for (const m of u.memberships) {
      console.log(`  org=${m.org.name} role=${m.role} leftAt=${m.leftAt} provAt=${m.provisionallyAddedAt}`);
    }
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
