import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  const candidates = await db.user.findMany({
    where: {
      OR: [
        { name: { contains: "MJA", mode: "insensitive" } },
        { name: { contains: "swthree", mode: "insensitive" } },
        { name: { contains: "sw3", mode: "insensitive" } },
      ],
    },
    include: {
      memberships: {
        include: { org: { select: { name: true } } },
      },
    },
  });
  for (const u of candidates) {
    console.log(`${u.id}  name="${u.name}"  phone=${u.phoneNumber}  email=${u.email}  onboarded=${u.onboarded}`);
    for (const m of u.memberships) {
      console.log(`  org=${m.org.name} role=${m.role} leftAt=${m.leftAt} provAt=${m.provisionallyAddedAt}`);
    }
  }
  if (candidates.length === 0) console.log("no MJA / swthree user found");
  console.log("\n=== Recent provisional members in Sutton FC ===");
  const provs = await db.membership.findMany({
    where: {
      orgId: "cmnnwhdx30000zfr85q18lyy9",
      provisionallyAddedAt: { not: null },
      leftAt: null,
    },
    include: { user: { select: { name: true, phoneNumber: true, createdAt: true } } },
    orderBy: { provisionallyAddedAt: "desc" },
  });
  for (const m of provs) {
    console.log(`  ${m.user.name}  phone=${m.user.phoneNumber}  added=${m.provisionallyAddedAt}`);
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
