/**
 * One-off: queue a corrected MoM announcement for the Apr 21 7-7 match.
 *
 * The bot fired the original announcement at 15:04 saying "2/4 votes"
 * because the old code clipped the tally with `take: 3`. Real total
 * was 8 votes across 7 different recipients. This posts a fresh
 * group message with the right total and the full vote breakdown.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  const match = await db.match.findFirst({
    where: { isHistorical: false, status: "COMPLETED" },
    orderBy: { date: "desc" },
    include: { activity: { include: { sport: true } } },
  });
  if (!match) {
    console.log("No completed match found");
    return;
  }
  const activity = match.activity;
  const sport = activity.sport;

  const votes = await db.moMVote.groupBy({
    by: ["playerId"],
    where: { matchId: match.id },
    _count: { playerId: true },
  });
  if (votes.length === 0) {
    console.log("No MoM votes for this match");
    return;
  }

  const allUsers = await db.user.findMany({
    where: { id: { in: votes.map((v) => v.playerId) } },
    select: { id: true, name: true },
  });
  const nameById = new Map(allUsers.map((u) => [u.id, u.name ?? "—"]));
  const tally = votes
    .map((v) => ({
      name: nameById.get(v.playerId) ?? "—",
      votes: v._count.playerId,
    }))
    .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));

  const totalVotes = tally.reduce((s, t) => s + t.votes, 0);
  const topCount = tally[0].votes;
  const topNames = tally.filter((t) => t.votes === topCount).map((t) => t.name);
  const sharedHeader = topNames.length > 1;
  const namesText = sharedHeader
    ? topNames.length === 2
      ? `${topNames[0]} & ${topNames[1]}`
      : `${topNames.slice(0, -1).join(", ")} & ${topNames.slice(-1)[0]}`
    : topNames[0];
  const breakdown = tally.map((t) => `• ${t.name} — ${t.votes}`).join("\n");

  const text =
    `🛠️ *Correction — ${sport.mvpLabel}, ${activity.name}*\n\n` +
    `Earlier announcement had the wrong total (2/4 votes). ` +
    `Real result was 8 votes across 7 players:\n\n` +
    (sharedHeader
      ? `🏆 Shared between *${namesText}* (${topCount} vote${topCount === 1 ? "" : "s"} each)\n\n`
      : `🏆 *${namesText}* (${topCount}/${totalVotes} votes)\n\n`) +
    `Votes:\n${breakdown}\n\n` +
    `Sorry for the mix-up — fixed now 🙏`;

  const org = await db.organisation.findFirst({
    where: { activities: { some: { id: activity.id } } },
    select: { id: true, name: true },
  });
  if (!org) {
    console.log("Org not found");
    return;
  }

  const job = await db.botJob.create({
    data: { orgId: org.id, kind: "group", text },
  });
  console.log(`Queued BotJob ${job.id} for org ${org.name}.`);
  console.log("\n--- Message preview ---\n");
  console.log(text);
  console.log("\n--- end ---\n");
  console.log("Bot will post on its next 5-min poll cycle.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => process.exit(0));
