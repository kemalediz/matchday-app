/**
 * Diagnose recurring "Nunu" + "Michael Allen" provisioning bugs.
 * Kemal keeps merging Nunu→Elnur Mammadov and another weird name→
 * Michael Allen. We need to know:
 *   - Are there multiple users with overlapping names that the
 *     fuzzy matcher punts on (returns null → provisions ghost)?
 *   - What phone numbers / pushnames are coming through for each?
 *   - What does the recent AnalyzedMessage history say about who
 *     authored the message that produced the ghost?
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  for (const needle of ["Elnur", "Nunu", "Michael"]) {
    console.log(`\n=== Users matching "${needle}" ===`);
    const users = await db.user.findMany({
      where: {
        OR: [
          { name: { contains: needle, mode: "insensitive" } },
          { email: { contains: needle.toLowerCase() } },
        ],
      },
      select: {
        id: true,
        name: true,
        email: true,
        phoneNumber: true,
        memberships: {
          select: { orgId: true, role: true, leftAt: true, provisionallyAddedAt: true },
        },
      },
    });
    for (const u of users) {
      const m0 = u.memberships[0];
      const memInfo = m0
        ? `role=${m0.role} leftAt=${m0.leftAt?.toISOString() ?? "-"} prov=${m0.provisionallyAddedAt?.toISOString() ?? "-"}`
        : "no memberships";
      console.log(`  id=${u.id}  name="${u.name}"  email=${u.email}  phone=${u.phoneNumber}  ${memInfo}`);
    }
  }

  // What's the provisional row that's currently visible in the UI?
  console.log("\n=== Active provisional memberships (any) ===");
  const provs = await db.membership.findMany({
    where: { provisionallyAddedAt: { not: null }, leftAt: null },
    include: {
      user: {
        select: { id: true, name: true, email: true, phoneNumber: true },
      },
    },
    orderBy: { provisionallyAddedAt: "desc" },
  });
  for (const p of provs) {
    console.log(
      `  ${p.user.name?.padEnd(20)} id=${p.user.id}  email=${p.user.email}  phone=${p.user.phoneNumber}  prov=${p.provisionallyAddedAt?.toISOString()}`,
    );
  }

  // Recent AnalyzedMessage rows for Nunu and Michael authors
  console.log("\n=== Recent AnalyzedMessage rows referencing Nunu/Michael ===");
  const recent = await db.analyzedMessage.findMany({
    where: {
      OR: [
        { body: { contains: "Nunu", mode: "insensitive" } },
        { body: { contains: "Michael", mode: "insensitive" } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: {
      createdAt: true,
      authorPhone: true,
      authorUserId: true,
      handledBy: true,
      intent: true,
      body: true,
    },
  });
  for (const a of recent) {
    console.log(
      `  ${a.createdAt.toISOString().slice(0, 19)}  phone=${a.authorPhone ?? "-"}  user=${a.authorUserId?.slice(0, 8) ?? "-"}  ${a.handledBy}/${a.intent}  body=${(a.body ?? "").slice(0, 80).replace(/\n/g, " ")}`,
    );
  }

  // Anyone whose name starts with "Nunu" or "Michael" — fuzzy first-name
  // candidates that could be falling through to provisioning
  console.log("\n=== Fuzzy candidates: names starting with 'Nu' (3+ chars) ===");
  const fuzzyNu = await db.user.findMany({
    where: { name: { startsWith: "Nu", mode: "insensitive" } },
    select: { id: true, name: true, phoneNumber: true },
  });
  for (const u of fuzzyNu) {
    console.log(`  ${u.name?.padEnd(25)} phone=${u.phoneNumber}  id=${u.id}`);
  }
  console.log("\n=== Fuzzy candidates: names starting with 'Mi' (3+ chars) ===");
  const fuzzyMi = await db.user.findMany({
    where: { name: { startsWith: "Mi", mode: "insensitive" } },
    select: { id: true, name: true, phoneNumber: true },
  });
  for (const u of fuzzyMi) {
    console.log(`  ${u.name?.padEnd(25)} phone=${u.phoneNumber}  id=${u.id}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => process.exit(0));
