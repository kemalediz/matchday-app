import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const users = await db.user.findMany({
    select: { name: true, email: true, phoneNumber: true, isActive: true },
    orderBy: { isActive: "desc" },
  });

  const withPhone = users.filter((u) => u.phoneNumber);
  const active = users.filter((u) => u.isActive);
  const activeWithPhone = active.filter((u) => u.phoneNumber);

  console.log(`Users: ${users.length}  with phone: ${withPhone.length}`);
  console.log(`Active: ${active.length}  with phone: ${activeWithPhone.length}`);
  console.log();
  console.log("Phone numbers by player:");
  users
    .filter((u) => u.phoneNumber)
    .forEach((u) => {
      console.log(`  ${(u.name ?? u.email).padEnd(22)}  ${u.phoneNumber}  ${u.isActive ? "" : "[inactive]"}`);
    });
  console.log();
  console.log("Missing phones (active only):");
  active
    .filter((u) => !u.phoneNumber)
    .forEach((u) => console.log(`  - ${u.name ?? u.email}`));

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
