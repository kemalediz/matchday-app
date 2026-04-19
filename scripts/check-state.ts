import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);
  const matches = await db.match.findMany({
    include: {
      activity: { select: { name: true } },
      attendances: { select: { status: true } },
    },
    orderBy: { date: "desc" },
    take: 5,
  });
  console.log(`Matches (${matches.length}):`);
  for (const m of matches) {
    console.log(`  ${m.id}  ${m.activity.name}  ${m.date.toISOString()}  status=${m.status}  att=${m.attendances.length}  scored=${m.redScore != null}`);
  }
  const sent = await db.sentNotification.findMany({ orderBy: { createdAt: "desc" }, take: 10 });
  console.log(`\nSentNotifications (${sent.length}):`);
  for (const s of sent) {
    console.log(`  ${s.createdAt.toISOString()}  ${s.key}`);
  }
  const jobs = await db.botJob.findMany({ orderBy: { createdAt: "desc" }, take: 5 });
  console.log(`\nBotJobs (${jobs.length}):`);
  for (const j of jobs) {
    console.log(`  ${j.id}  kind=${j.kind}  sent=${j.sentAt ?? "no"}`);
  }
  await db.$disconnect();
}
main();
