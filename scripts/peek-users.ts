import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  const users = await db.user.findMany({
    where: { memberships: { some: { org: { slug: "sutton-fc" } } } },
    select: { id: true, name: true, phoneNumber: true, isSuperadmin: true },
    orderBy: { name: "asc" },
  });
  console.log("DB user names (what resolveSender tries to match against):");
  for (const u of users) {
    console.log(`  "${u.name}"  phone=${u.phoneNumber ?? "-"}  admin=${u.isSuperadmin}`);
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
