import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  // 1. Recent analyzed messages
  console.log("=== Analyzed messages (last 5h) ===");
  const rows = await db.analyzedMessage.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 5 * 60 * 60 * 1000) } },
    orderBy: { createdAt: "asc" },
  });
  for (const r of rows) {
    const t = r.createdAt.toLocaleString("en-GB", { timeZone: "Europe/London" });
    console.log(
      `[${t}] handledBy=${r.handledBy} intent=${r.intent ?? "-"} action=${r.action ?? "-"} conf=${r.confidence ?? "-"} userId=${r.authorUserId ?? "null"} phone=${r.authorPhone ?? "null"}`,
    );
    console.log(`   body: "${(r.body ?? "").slice(0, 120)}"`);
    if (r.reasoning) console.log(`   reasoning: ${r.reasoning.slice(0, 300)}`);
  }

  // 2. All users whose name contains Karahan
  console.log("\n=== Karahan in users table ===");
  const users = await db.user.findMany({
    where: { name: { contains: "Karahan", mode: "insensitive" } },
    select: { id: true, name: true, phoneNumber: true },
  });
  console.log(users);

  // 3. Current upcoming match + attendances
  console.log("\n=== Upcoming matches ===");
  const ms = await db.match.findMany({
    where: { status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] }, isHistorical: false },
    orderBy: { date: "asc" },
    include: {
      activity: { select: { name: true } },
      attendances: { include: { user: { select: { name: true } } }, orderBy: { position: "asc" } },
    },
  });
  for (const m of ms) {
    console.log(`\n${m.activity.name} ${m.date.toLocaleString("en-GB", { timeZone: "Europe/London" })} status=${m.status} id=${m.id}`);
    for (const a of m.attendances) {
      console.log(`  [${a.status}] pos=${a.position} ${a.user.name}`);
    }
  }

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
