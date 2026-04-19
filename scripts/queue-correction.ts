/**
 * One-off: queue a corrected IN list to the group because the earlier
 * 17:00 daily-in-list had stale data.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const match = await db.match.findFirst({
    where: {
      date: { gte: new Date() },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
    },
    orderBy: { date: "asc" },
    include: {
      activity: { select: { name: true, orgId: true } },
      attendances: {
        where: { status: "CONFIRMED" },
        include: { user: { select: { name: true } } },
        orderBy: { position: "asc" },
      },
    },
  });
  if (!match) throw new Error("No upcoming match");

  const need = Math.max(0, match.maxPlayers - match.attendances.length);
  const list = match.attendances
    .map((a, i) => `${i + 1}. ${a.user.name ?? "?"}`)
    .join("\n");

  const text = `🗓 *${match.activity.name}* — need *${need} more*.\n\n${list}`;

  const job = await db.botJob.create({
    data: { orgId: match.activity.orgId, kind: "group", text },
  });

  console.log(`Queued BotJob ${job.id}`);
  console.log(text);

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
