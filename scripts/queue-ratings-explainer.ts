/**
 * Queue a group post explaining how seed ratings → peer ratings → Elo
 * and how the team balancer actually works. Triggered by Enayem
 * asking in the group; good moment to demystify the mechanism.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const GROUP_ID = "447525334985-1607872139@g.us";

const TEXT = `Good question, Enayem 👇

Teams are balanced by algorithm, not by hand. Each player has a *rating* that feeds into it — and the rating evolves in 3 stages:

1. *Seed rating* — admin-set 1–10 starting score. For tonight I calibrated these based on common opinions in the group (e.g. Wasim 9, Sait/Kemal 8, Idris 7, newer players ~6, etc.).

2. *Peer ratings* — after each match I'll DM you a link, takes under a minute to score your teammates 1–10. Once a player has 3+ peer ratings, those *replace* the seed automatically.

3. *Elo* — from match scores. A 7–3 shifts ratings more than 5–4 — margin of victory counts, like chess.

The *balancer* itself:
• Snake-drafts players by rating into Red/Yellow so the totals are close
• Then runs 1,000 random swaps to also balance positions per the formation (GK / DEF / MID / FWD)
• Goal: minimise rating diff AND position imbalance

Over a few weeks ratings self-calibrate via peer input + results. Admin doesn't have to tune anything — it just gets more balanced week on week.

Any other Qs shout.`;

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const org = await db.organisation.findFirst({ where: { whatsappGroupId: GROUP_ID } });
  if (!org) throw new Error("org not found");
  const job = await db.botJob.create({
    data: { orgId: org.id, kind: "group", phone: null, text: TEXT },
  });
  console.log(`Queued BotJob ${job.id} — bot will post within ~5 min.\n`);
  console.log(`--- preview ---\n${TEXT}`);

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
