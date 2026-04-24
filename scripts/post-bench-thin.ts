import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
/** One-off: post the bench-thin reminder that would normally fire at
 *  17:00. Missed today because the rule was just shipped. */
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
      attendances: true,
    },
    orderBy: { date: "asc" },
  });
  if (!match) throw new Error("no upcoming match");
  const confirmed = match.attendances.filter((a) => a.status === "CONFIRMED").length;
  const bench = match.attendances.filter((a) => a.status === "BENCH").length;
  if (confirmed < match.maxPlayers) { console.log("squad not full"); return; }
  if (bench >= 3) { console.log("bench fine"); return; }
  const gap = 3 - bench;
  const benchLine =
    bench === 0 ? "*nobody* on the bench" : bench === 1 ? "only *1* on the bench" : `only *${bench}* on the bench`;
  const text =
    `🪑 Squad is locked at *${match.maxPlayers}/${match.maxPlayers}* for *${match.activity.name}* ` +
    `but we've got ${benchLine}. ` +
    `If anyone drops, we're short again. Say *IN* to pad the bench — ${gap} more would be ideal 🙌`;
  await db.botJob.create({ data: { orgId: org.id, kind: "group", text } });
  console.log("Queued bench-thin BotJob.");
  console.log(text);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
