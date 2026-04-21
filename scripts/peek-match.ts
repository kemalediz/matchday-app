import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  const matches = await db.match.findMany({
    where: { activity: { org: { slug: "sutton" } } },
    include: { activity: { select: { name: true } } },
    orderBy: { date: "desc" },
    take: 5,
  });
  for (const m of matches) {
    console.log(`${m.activity.name}  ${m.date.toISOString()}  status=${m.status}  red=${m.redScore}  yellow=${m.yellowScore}`);
  }
  console.log("\n---analysed messages in last 2h---");
  const rows = await db.analyzedMessage.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 2 * 60 * 60 * 1000) } },
    orderBy: { createdAt: "desc" },
  });
  for (const r of rows) {
    const t = r.createdAt.toLocaleString("en-GB", { timeZone: "Europe/London" });
    const body = (r.body ?? "").slice(0, 80).replace(/\n/g, " ");
    console.log(`  [${t}]  ${r.handledBy.padEnd(10)} intent=${(r.intent ?? "-").padEnd(22)} "${body}"`);
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
