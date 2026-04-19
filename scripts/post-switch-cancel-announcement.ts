/**
 * One-off: queue a BotJob with the group announcement for the new
 * switch-format + cancel flow. Scheduler picks it up on next tick,
 * bot posts in the Sutton FC group.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const ORG_SLUG = "sutton-fc";

const TEXT = `📣 *Heads-up from MatchDay bot*

New feature for those weeks we struggle to fill the squad:

🔁 *Switch to a smaller format*
If we're short the day before the match at 10am, I'll DM the admins with a one-tap link to switch to a smaller format (e.g. 7-a-side → 5-a-side). The first players stay in the lineup, the rest move to the bench. Bot auto-posts the updated lineup here once switched.

🚨 *Cancel*
If we're *still* below the minimum by 6pm the same day, I'll DM the admins again with a cancel link — in time to avoid losing the booking fee.

Any admin can also switch or cancel anytime from the MatchDay portal (/admin/matches/...) — DM nudges are just reminders, not the only way to act.

Keep saying IN — the fewer nudges I have to send, the better 😄`;

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const org = await db.organisation.findUnique({ where: { slug: ORG_SLUG } });
  if (!org) throw new Error("Org not found");

  const job = await db.botJob.create({
    data: { orgId: org.id, kind: "group", text: TEXT },
  });
  console.log(`Queued group-message BotJob ${job.id}`);
  console.log("Bot will post within ~5 min (next scheduler tick).");

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
