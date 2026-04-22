import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  console.log("=== Analyzed messages (last 30 min) ===");
  const rows = await db.analyzedMessage.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } },
    orderBy: { createdAt: "asc" },
  });
  for (const r of rows) {
    const t = r.createdAt.toLocaleString("en-GB", { timeZone: "Europe/London" });
    console.log(`[${t}] ${r.handledBy} intent=${r.intent} action=${r.action} conf=${r.confidence} userId=${r.authorUserId ?? "null"}`);
    console.log(`   body: "${r.body}"`);
    if (r.reasoning) console.log(`   reasoning: ${r.reasoning.slice(0, 500)}`);
  }
  console.log("\n=== Karahan in users ===");
  const users = await db.user.findMany({
    where: { name: { contains: "Karahan", mode: "insensitive" } },
    select: { id: true, name: true, email: true, phoneNumber: true },
  });
  console.log(users);
  console.log("\n=== Memberships with provisionallyAddedAt ===");
  const provs = await db.membership.findMany({
    where: { provisionallyAddedAt: { not: null }, leftAt: null },
    include: { user: { select: { name: true } } },
  });
  console.log(provs);
  console.log("\n=== Upcoming match attendances ===");
  const m = await db.match.findFirst({
    where: { status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] }, isHistorical: false },
    include: { attendances: { include: { user: { select: { name: true } } }, orderBy: { position: "asc" } } },
    orderBy: { date: "asc" },
  });
  if (m) for (const a of m.attendances) console.log(`  [${a.status}] pos=${a.position} ${a.user.name}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
