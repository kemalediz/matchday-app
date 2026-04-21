import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  const m = await db.match.findFirst({
    where: { status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] } },
    include: {
      activity: { select: { name: true } },
      teamAssignments: { include: { user: { select: { name: true } } } },
    },
    orderBy: { date: "asc" },
  });
  if (!m) { console.log("no upcoming match"); return; }
  console.log(`Match:   ${m.activity.name}`);
  console.log(`Status:  ${m.status}`);
  console.log(`Kickoff: ${m.date.toLocaleString("en-GB", { timeZone: "Europe/London" })}`);
  console.log(`Team assignments: ${m.teamAssignments.length}`);
  for (const t of m.teamAssignments) {
    console.log(`  ${t.team}  ${t.user.name}`);
  }
  const sent = await db.sentNotification.findFirst({ where: { key: `${m.id}:teams-morning` } });
  console.log(`\nteams-morning post sent: ${sent ? sent.createdAt.toISOString() : "(not yet)"}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
