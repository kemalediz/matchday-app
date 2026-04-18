/**
 * One-off: re-run normalisePhone over every stored phoneNumber so that
 * legacy rows get the latest cleanup (e.g. stripping invisible bidi marks
 * that sneak in when numbers are pasted from WhatsApp).
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { normalisePhone } from "../src/lib/phone.ts";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const users = await db.user.findMany({
    where: { phoneNumber: { not: null } },
    select: { id: true, name: true, phoneNumber: true },
  });

  let fixed = 0;
  for (const u of users) {
    const norm = normalisePhone(u.phoneNumber!);
    if (norm && norm !== u.phoneNumber) {
      await db.user.update({ where: { id: u.id }, data: { phoneNumber: norm } });
      const before = JSON.stringify(u.phoneNumber);
      const after = JSON.stringify(norm);
      console.log(`  fixed  ${(u.name ?? "").padEnd(22)}  ${before} -> ${after}`);
      fixed++;
    }
  }

  console.log(`\nScanned ${users.length} phone numbers, fixed ${fixed}.`);
  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
