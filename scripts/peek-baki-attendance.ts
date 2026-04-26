import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  const baki = await db.user.findFirst({ where: { name: { contains: "Baki", mode: "insensitive" } } });
  if (!baki) throw new Error("no baki");
  const att = await db.attendance.findMany({
    where: { userId: baki.id },
    include: { match: { select: { date: true } } },
    orderBy: { createdAt: "desc" },
  });
  for (const a of att) {
    console.log(`status=${a.status} pos=${a.position} matchDate=${a.match.date.toISOString()} createdAt=${a.createdAt.toISOString()} respondedAt=${a.respondedAt.toISOString()}`);
  }
  console.log("\nAll AnalyzedMessages today from Baki's phone:");
  const msgs = await db.analyzedMessage.findMany({
    where: { OR: [{ authorUserId: baki.id }, { authorPhone: baki.phoneNumber ?? "_" }], createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  for (const m of msgs) {
    const t = m.createdAt.toLocaleString("en-GB", { timeZone: "Europe/London" });
    console.log(`  [${t}] intent=${m.intent} action=${m.action} userId=${m.authorUserId ?? "null"} body="${(m.body ?? "").slice(0, 90)}"`);
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
