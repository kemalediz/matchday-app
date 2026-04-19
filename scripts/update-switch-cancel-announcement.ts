/**
 * Update (or re-queue) the switch/cancel announcement with the final
 * wording. Safe to run multiple times: if the most recent announcement
 * is still unsent we patch it; if it's already sent we do nothing
 * (manual correction post is a separate decision).
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const ORG_SLUG = "sutton-fc";

const TEXT = `📣 *Heads-up from MatchDay bot*

New feature for those weeks we struggle to fill the squad:

🔁 *Switch to a smaller format*
At *10am the day before the match*, if we're short, I'll DM the admins with a one-tap link to switch to a smaller format (e.g. 7-a-side → 5-a-side). The first players stay in the lineup, the rest move to the bench. Bot auto-posts the updated lineup here once switched.

🚨 *Cancel*
At *6pm the day before the match*, if we're *still* below the minimum, I'll DM the admins again with a cancel link — in time to avoid losing the booking fee.

Any admin can also switch or cancel anytime from the MatchDay portal (/admin/matches/...) — DM nudges are just reminders, not the only way to act.

Keep saying IN — the fewer nudges I have to send, the better 😄`;

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const org = await db.organisation.findUnique({ where: { slug: ORG_SLUG } });
  if (!org) throw new Error("Org not found");

  const jobs = await db.botJob.findMany({
    where: { orgId: org.id, kind: "group", sentAt: null },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  const target = jobs.find((j) => j.text.includes("Switch to a smaller format"));
  if (!target) {
    console.log("No unsent announcement job to update (already posted or missing).");
  } else {
    await db.botJob.update({ where: { id: target.id }, data: { text: TEXT } });
    console.log(`Updated unsent announcement ${target.id} with cleaned-up wording.`);
  }

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
