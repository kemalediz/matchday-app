import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);
  const matches = await db.match.findMany({
    where: { isHistorical: false },
    orderBy: { date: "desc" },
    take: 5,
    include: { activity: { select: { name: true } } },
  });
  for (const m of matches) {
    console.log(`${m.date.toISOString()}  ${m.status.padEnd(18)} ${m.activity.name}  id=${m.id}`);
    const sn = await db.sentNotification.findMany({
      where: { matchId: m.id },
      orderBy: { createdAt: "asc" },
      select: { kind: true, key: true, createdAt: true },
    });
    for (const s of sn) {
      console.log(`   ${s.createdAt.toISOString()}  ${s.kind.padEnd(20)} ${s.key}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => process.exit(0));
