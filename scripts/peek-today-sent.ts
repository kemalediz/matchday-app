import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  const rows = await db.sentNotification.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    orderBy: { createdAt: "asc" },
  });
  for (const r of rows) {
    const t = r.createdAt.toLocaleString("en-GB", { timeZone: "Europe/London" });
    console.log(`[${t}] kind=${r.kind} key=${r.key}`);
  }
  console.log(`\n=== Recent BotJobs last 12h ===`);
  const jobs = await db.botJob.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 12 * 60 * 60 * 1000) } },
    orderBy: { createdAt: "asc" },
  });
  for (const j of jobs) {
    const t = j.createdAt.toLocaleString("en-GB", { timeZone: "Europe/London" });
    console.log(`[${t}] kind=${j.kind} phone=${j.phone ?? "-"} sentAt=${j.sentAt ?? "null"}  text="${j.text.slice(0, 70)}..."`);
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
