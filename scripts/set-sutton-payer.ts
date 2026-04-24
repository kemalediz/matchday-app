import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);
  const elvin = await db.user.findFirst({
    where: { name: { contains: "Elvin", mode: "insensitive" } },
    select: { id: true, name: true },
  });
  if (!elvin) throw new Error("no Elvin found");
  const org = await db.organisation.findFirst({ where: { whatsappBotEnabled: true } });
  if (!org) throw new Error("no bot-enabled org");
  await db.organisation.update({
    where: { id: org.id },
    data: { paymentHolderId: elvin.id },
  });
  console.log(`Set paymentHolderId=${elvin.id} (${elvin.name}) on org ${org.id}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
