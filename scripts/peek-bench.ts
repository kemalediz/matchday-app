import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);
  const m = await db.match.findFirst({
    where: { isHistorical: false, status: { not: "COMPLETED" } },
    orderBy: { date: "asc" },
  });
  if (!m) return console.log("no match");
  const bench = await db.attendance.findMany({
    where: { matchId: m.id, status: "BENCH" },
    include: { user: { select: { name: true, phoneNumber: true, email: true } } },
    orderBy: { position: "asc" },
  });
  console.log(`Bench (${bench.length}):`);
  for (const a of bench) {
    console.log(`  pos=${a.position} ${a.user.name?.padEnd(25)} phone=${a.user.phoneNumber}  email=${a.user.email}  respondedAt=${a.respondedAt.toISOString()}`);
  }
  // Last 5 AnalyzedMessages from Enayem-ish authors
  const recent = await db.analyzedMessage.findMany({
    orderBy: { createdAt: "desc" },
    take: 8,
    select: { createdAt: true, authorPhone: true, authorUserId: true, body: true, intent: true, action: true },
  });
  console.log(`\nLast 8 AnalyzedMessages:`);
  for (const r of recent.reverse()) {
    console.log(`  ${r.createdAt.toISOString().slice(11,19)}  phone=${r.authorPhone ?? "-"}  userId=${r.authorUserId?.slice(0,8) ?? "-"}  intent=${r.intent}  action=${r.action}`);
    console.log(`    body: ${(r.body ?? "").slice(0, 120).replace(/\n/g, " ")}`);
  }
}
main().catch(console.error).finally(() => process.exit(0));
