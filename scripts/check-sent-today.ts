import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const rows = await db.sentNotification.findMany({
    where: { createdAt: { gte: startOfDay } },
    orderBy: { createdAt: "asc" },
  });
  console.log(`SentNotifications created today (UTC ${startOfDay.toISOString()}+): ${rows.length}`);
  for (const r of rows) {
    const bst = r.createdAt.toLocaleString("en-GB", { timeZone: "Europe/London" });
    console.log(`  [${bst}]  kind=${r.kind}  key=${r.key}`);
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
