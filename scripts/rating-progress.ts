import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  const m = await db.match.findFirst({
    where: { status: "COMPLETED", isHistorical: false },
    orderBy: { date: "desc" },
    include: {
      activity: true,
      attendances: {
        where: { status: { in: ["CONFIRMED", "BENCH"] } },
        include: { user: { select: { id: true, name: true } } },
      },
      ratings: { select: { raterId: true } },
    },
  });
  if (!m) { console.log("no completed match"); return; }
  console.log(`${m.activity.name} — ${m.date.toLocaleString("en-GB", { timeZone: "Europe/London" })}`);
  console.log(`Score: ${m.redScore}-${m.yellowScore}`);
  const raterIds = new Set(m.ratings.map((r) => r.raterId));
  const players = m.attendances;
  console.log(`\nRated: ${raterIds.size}/${players.length}`);
  console.log("\n✅ Submitted:");
  for (const a of players.filter((p) => raterIds.has(p.user.id))) {
    console.log(`  ${a.user.name}`);
  }
  console.log("\n⏳ Pending:");
  for (const a of players.filter((p) => !raterIds.has(p.user.id))) {
    console.log(`  ${a.user.name}`);
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
