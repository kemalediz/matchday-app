import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);
  const jobs = await db.botJob.findMany({ orderBy: { createdAt: "desc" }, take: 10 });
  const org = await db.organisation.findUnique({ where: { slug: "sutton-fc" } });
  console.log(`Org enabled: ${org?.whatsappBotEnabled}`);
  console.log(`Jobs (${jobs.length}):`);
  for (const j of jobs) {
    console.log(`  ${j.id}  kind=${j.kind}  sent=${j.sentAt ?? "no"}  text="${j.text.slice(0, 60)}…"`);
  }
  await db.$disconnect();
}
main();
