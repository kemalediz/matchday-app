/**
 * One-off: mark kemal.ediz@cressoft.io as the platform superadmin.
 * Superadmins see every org in the system and can administrate any of
 * them regardless of membership role. Intended for platform operators
 * (you), NOT org admins.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const SUPERADMIN_EMAIL = "kemal.ediz@cressoft.io";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const user = await db.user.update({
    where: { email: SUPERADMIN_EMAIL },
    data: { isSuperadmin: true },
    select: { id: true, name: true, email: true, isSuperadmin: true },
  });

  console.log(`Set superadmin: ${user.name ?? user.email} (${user.email}) → isSuperadmin=${user.isSuperadmin}`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
