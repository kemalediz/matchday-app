import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  const karahan = await db.user.findFirst({ where: { name: "Karahan Ozturk" } });
  if (!karahan) throw new Error("no karahan");
  await db.attendance.updateMany({ where: { userId: karahan.id }, data: { position: 9 } });
  console.log("Restored Karahan to pos=9");
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
