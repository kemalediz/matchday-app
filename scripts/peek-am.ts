import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  const row = await db.analyzedMessage.findFirst({ orderBy: { createdAt: "desc" } });
  console.log(JSON.stringify(row, null, 2));
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
