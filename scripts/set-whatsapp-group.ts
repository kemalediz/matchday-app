import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const ORG_SLUG = "sutton-fc";
const GROUP_ID = "447525334985-1607872139@g.us";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const org = await db.organisation.update({
    where: { slug: ORG_SLUG },
    data: { whatsappGroupId: GROUP_ID, whatsappBotEnabled: true },
    select: { name: true, whatsappGroupId: true, whatsappBotEnabled: true },
  });

  console.log(`Updated org "${org.name}":`);
  console.log(`  whatsappGroupId:    ${org.whatsappGroupId}`);
  console.log(`  whatsappBotEnabled: ${org.whatsappBotEnabled}`);

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
