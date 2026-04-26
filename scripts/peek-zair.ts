import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  console.log("=== Latest 12h analyzed ===");
  const rows = await db.analyzedMessage.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 12 * 60 * 60 * 1000) } },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  for (const r of rows) {
    const t = r.createdAt.toLocaleString("en-GB", { timeZone: "Europe/London" });
    console.log(`[${t}] handledBy=${r.handledBy} intent=${r.intent} action=${r.action} userId=${r.authorUserId ?? "null"}`);
    console.log(`  body: "${(r.body ?? "").slice(0, 130).replace(/\n/g, " ⏎ ")}"`);
    if (r.reasoning) console.log(`  reasoning: ${r.reasoning.slice(0, 250)}`);
  }
  console.log("\n=== Zair user(s) ===");
  const zairs = await db.user.findMany({
    where: { name: { contains: "Zair", mode: "insensitive" } },
    select: { id: true, name: true, phoneNumber: true, email: true },
  });
  console.log(zairs);
  console.log("\n=== Match attendances ===");
  const m = await db.match.findFirst({
    where: { status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] }, isHistorical: false },
    include: { attendances: { include: { user: { select: { name: true } } }, orderBy: { position: "asc" } } },
    orderBy: { date: "asc" },
  });
  if (m) {
    console.log(`Match ${m.id} ${m.date.toISOString()} attendanceDeadline=${m.attendanceDeadline.toISOString()}`);
    for (const a of m.attendances) console.log(`  [${a.status}] pos=${a.position} ${a.user.name}`);
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
