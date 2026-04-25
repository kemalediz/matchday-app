import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  const m = await db.match.findFirst({
    where: { status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] }, isHistorical: false },
    include: { activity: true },
    orderBy: { date: "asc" },
  });
  if (!m) throw new Error("no upcoming match");
  console.log(`Match id: ${m.id}`);
  console.log(`Match date raw (UTC ISO): ${m.date.toISOString()}`);
  console.log(`Match date as London: ${new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(m.date)}`);
  console.log(`Match date as UTC label: ${new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(m.date)}`);
  console.log(`\nActivity: ${m.activity.name}`);
  console.log(`Activity time field: ${m.activity.time}`);
  console.log(`Activity dayOfWeek: ${m.activity.dayOfWeek}`);
  console.log(`Activity venue: ${m.activity.venue}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
