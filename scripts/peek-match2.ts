import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  const matches = await db.match.findMany({
    include: { activity: { select: { name: true, org: { select: { name: true } } } } },
    orderBy: { date: "desc" },
    take: 5,
  });
  for (const m of matches) {
    const dstr = m.date.toLocaleString("en-GB", { timeZone: "Europe/London" });
    console.log(`${m.activity.org.name}  ${m.activity.name}  ${dstr}  status=${m.status}  red=${m.redScore}  yellow=${m.yellowScore}  updatedAt=${m.updatedAt.toLocaleString("en-GB", { timeZone: "Europe/London" })}`);
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
