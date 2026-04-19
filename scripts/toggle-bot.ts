/**
 * Quick toggle for whatsappBotEnabled on a single org. With it set to false
 * the due-posts endpoint returns nothing, so the bot (still running, still
 * watching IN/OUT) never posts group messages or DMs. Re-enable with:
 *   npm run bot:toggle -- on
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const ORG_SLUG = "sutton-fc";

async function main() {
  const arg = (process.argv[2] ?? "off").toLowerCase();
  const enable = arg === "on" || arg === "true" || arg === "1";

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const org = await db.organisation.update({
    where: { slug: ORG_SLUG },
    data: { whatsappBotEnabled: enable },
    select: { name: true, whatsappBotEnabled: true, whatsappGroupId: true },
  });

  console.log(`Org "${org.name}":`);
  console.log(`  whatsappBotEnabled = ${org.whatsappBotEnabled}`);
  console.log(`  whatsappGroupId    = ${org.whatsappGroupId}`);
  console.log();
  console.log(
    enable
      ? "🟢 Bot WILL post scheduled messages / polls / DMs for this org."
      : "🔴 Bot WILL NOT post scheduled messages / polls / DMs for this org.\n   (IN/OUT emoji reactions still work — they're reactions, not new messages.)",
  );

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
