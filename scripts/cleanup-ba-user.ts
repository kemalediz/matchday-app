import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  // Find Baki Sutton — real user.
  const baki = await db.user.findFirst({
    where: { name: { contains: "Baki", mode: "insensitive" } },
    select: { id: true, name: true, email: true },
  });
  console.log("Baki (real):", baki);

  // Find the bogus "ba" user.
  const ba = await db.user.findFirst({
    where: { name: "ba" },
    select: { id: true, name: true, email: true },
  });
  console.log("ba (bogus):", ba);

  if (!ba) {
    console.log("No 'ba' user to clean up.");
    return;
  }

  // Re-attribute any AnalyzedMessage rows authored by the bogus user
  // to the real Baki (if he exists). Otherwise just null them out.
  const targetId = baki?.id ?? null;
  const updated = await db.analyzedMessage.updateMany({
    where: { authorUserId: ba.id },
    data: { authorUserId: targetId },
  });
  console.log(`Re-attributed ${updated.count} AnalyzedMessage rows to ${targetId ?? "null"}.`);

  // Delete the bogus membership and user (cascade is OK — no other
  // attendances/ratings exist for a freshly-provisioned ghost).
  await db.membership.deleteMany({ where: { userId: ba.id } });
  await db.user.delete({ where: { id: ba.id } });
  console.log("Deleted bogus 'ba' user and memberships.");

  // Also soft-remove the real Baki Sutton from the org's player list
  // per admin request — preserves history via leftAt.
  if (baki) {
    const memberships = await db.membership.updateMany({
      where: { userId: baki.id, leftAt: null },
      data: { leftAt: new Date() },
    });
    console.log(`Soft-removed Baki Sutton from ${memberships.count} org(s).`);
  }

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
