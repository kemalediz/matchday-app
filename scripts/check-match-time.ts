import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  const m = await db.match.findFirst({
    where: { status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] } },
    include: { activity: { select: { name: true } } },
    orderBy: { date: "asc" },
  });
  if (!m) { console.log("no match"); return; }
  const now = new Date();
  const hoursUntil = (m.date.getTime() - now.getTime()) / (1000 * 60 * 60);
  console.log(`Activity:   ${m.activity.name}`);
  console.log(`Match ISO:  ${m.date.toISOString()} (UTC)`);
  console.log(`Match BST:  ${m.date.toLocaleString("en-GB", { timeZone: "Europe/London" })}`);
  console.log(`Now ISO:    ${now.toISOString()}`);
  console.log(`Now BST:    ${now.toLocaleString("en-GB", { timeZone: "Europe/London" })}`);
  console.log(`Hours until kickoff: ${hoursUntil.toFixed(2)}`);
  const sn = await db.sentNotification.findFirst({
    where: { key: `${m.id}:football-gear-reminder` },
  });
  console.log(`\nfootball-gear-reminder SentNotification:`, sn ? sn.createdAt.toISOString() : "(not sent)");
  const preKick = await db.sentNotification.findFirst({
    where: { key: `${m.id}:pre-kickoff` },
  });
  console.log(`pre-kickoff SentNotification:           `, preKick ? preKick.createdAt.toISOString() : "(not sent)");
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
