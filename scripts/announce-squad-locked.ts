import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  const org = await db.organisation.findFirst({ where: { whatsappBotEnabled: true } });
  if (!org) throw new Error("no bot-enabled org");
  const match = await db.match.findFirst({
    where: {
      activity: { orgId: org.id },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
      isHistorical: false,
    },
    include: {
      activity: { select: { name: true } },
      attendances: { where: { status: "CONFIRMED" } },
    },
    orderBy: { date: "asc" },
  });
  if (!match) throw new Error("no upcoming match");

  const key = `${match.id}:squad-locked`;
  const existing = await db.sentNotification.findFirst({ where: { key } });
  if (existing) { console.log("already announced"); return; }

  const kickoffLondon = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(match.date).replace(/,/g, "");

  await db.botJob.create({
    data: {
      orgId: org.id,
      kind: "group",
      text:
        `✅ *Squad locked!* We're full at *${match.maxPlayers}/${match.maxPlayers}* for *${match.activity.name}* on ${kickoffLondon}.\n\n` +
        `See you all there 🙌⚽`,
    },
  });
  await db.sentNotification.create({
    data: { matchId: match.id, kind: "group-message", key },
  });
  console.log(`Queued squad-locked announcement for match ${match.id}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
