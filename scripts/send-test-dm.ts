/**
 * One-off: queue a DM containing a MatchDay magic link to Kemal so he
 * can test the link-to-sign-in flow before the rating page is fully
 * built. Uses a `sign-in` purpose (not `rate-match`) — clicking the
 * link just signs him into the dashboard, no rating UI required.
 *
 * Runs via `node --env-file=.env --import tsx scripts/send-test-dm.ts`.
 * The bot picks up the queued BotJob on its next 5-minute poll and
 * sends the DM via WhatsApp.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { signMagicLinkToken, buildMagicLinkUrl, MAGIC_LINK_TTL } from "../src/lib/magic-link.ts";

const OWNER_EMAIL = "kemal.ediz@cressoft.io";
const ORG_SLUG = "sutton-fc";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const user = await db.user.findUnique({ where: { email: OWNER_EMAIL } });
  if (!user) throw new Error(`User ${OWNER_EMAIL} not found`);
  if (!user.phoneNumber) throw new Error(`User ${OWNER_EMAIL} has no phoneNumber`);

  const org = await db.organisation.findUnique({ where: { slug: ORG_SLUG } });
  if (!org) throw new Error(`Org ${ORG_SLUG} not found`);

  const token = signMagicLinkToken({
    userId: user.id,
    purpose: "sign-in",
    ttlSeconds: MAGIC_LINK_TTL.rateMatch, // 5d — generous for testing
  });
  const link = buildMagicLinkUrl(token);

  const text = [
    `🧪 MatchDay magic-link test`,
    ``,
    `Tap to sign in to MatchDay without email/password. This is the same link a player will receive after a match to rate teammates.`,
    ``,
    link,
    ``,
    `(Expires in 5 days. If anything's broken, reply here and Kemal-dev will fix.)`,
  ].join("\n");

  const phone = user.phoneNumber.replace(/^\+/, "");

  const job = await db.botJob.create({
    data: { orgId: org.id, kind: "dm", phone, text },
  });

  console.log(`Queued BotJob ${job.id}`);
  console.log(`  to:   ${user.phoneNumber}`);
  console.log(`  link: ${link}`);
  console.log(`Bot will deliver on its next scheduler tick (up to 5 min).`);

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
