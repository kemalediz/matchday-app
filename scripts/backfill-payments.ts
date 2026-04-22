import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

/**
 * One-off: retroactively mark the 8 players who ticked the Tuesday
 * payment poll as paid. Votes landed on WhatsApp before our poll-vote
 * → paidAt wiring shipped, so the server never heard about them.
 *
 * Source of truth: the "View votes" screen Kemal shared.
 */
const PAID_NAMES = [
  // Red
  "Idris Y",
  "Aydın Kocahal",
  "Aydın",
  "Mauricio",
  "Ibrahim Sahin",
  "Mustafa Cayir",
  // Yellow
  "Elnur Mammadov",
  "Ersin Sevindik",
  "Sait",
];

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const match = await db.match.findFirst({
    where: { status: "COMPLETED", isHistorical: false },
    orderBy: { date: "desc" },
    include: {
      attendances: {
        where: { status: "CONFIRMED" },
        include: { user: { select: { id: true, name: true } } },
      },
    },
  });
  if (!match) throw new Error("no match");

  const norm = (s: string) =>
    s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Match each paid name to exactly one attendance row.
  const paidNamesSet = new Set(PAID_NAMES.map(norm));
  // Also strip "Sutton Football" suffix used as a display-name trick for
  // WhatsApp grouping, and match by first name.
  function firstToken(s: string) {
    return norm(s).split(/\s+/)[0] ?? "";
  }

  const firstTokens = new Set(PAID_NAMES.map(firstToken));

  const matched: typeof match.attendances = [];
  for (const a of match.attendances) {
    const n = norm(a.user.name ?? "");
    const f = firstToken(a.user.name ?? "");
    if (paidNamesSet.has(n) || firstTokens.has(f)) matched.push(a);
  }

  console.log(`Match: ${match.id}  confirmed=${match.attendances.length}`);
  console.log(`Paid matched: ${matched.length}/${PAID_NAMES.length}`);
  for (const a of matched) console.log(`  ✓ ${a.user.name}`);
  const unmatched = match.attendances.filter((a) => !matched.includes(a));
  console.log("\nUnpaid (won't be updated):");
  for (const a of unmatched) console.log(`  · ${a.user.name}`);

  const now = new Date();
  const res = await db.attendance.updateMany({
    where: { id: { in: matched.map((a) => a.id) } },
    data: { paidAt: now },
  });
  console.log(`\nUpdated ${res.count} rows with paidAt=${now.toISOString()}`);

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
