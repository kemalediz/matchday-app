/**
 * Manually record IN for a list of players for the next upcoming match.
 * Useful when the WhatsApp backfill fails (Linked Devices history sync
 * sometimes can't reach pre-pairing messages) and we need to bring the
 * attendance state up to date.
 *
 * Usage:
 *   Edit the IN_PLAYERS array below to include the player names OR emails
 *   OR phone numbers people said IN with this week, then:
 *     node --env-file=.env --import tsx scripts/manual-attendance.ts
 *
 * Each identifier is looked up in this order:
 *   1. email match
 *   2. phoneNumber match (normalised)
 *   3. name match (case-insensitive, membership in this org)
 * The first found wins; unmatched identifiers are logged and skipped.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { normalisePhone } from "../src/lib/phone.ts";

const ORG_SLUG = "sutton-fc";

// EDIT ME — names / emails / phone numbers of the 9 (or however many)
// people who said IN in the group this week before the bot was live.
const IN_PLAYERS: string[] = [
  "Elvin",
  "Mustafa",
  "İdris",
  "Sait",
  "Kemal",
  "İbrahim",
  "Elnur",
  "Najib",
  "Wasim",
];

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const org = await db.organisation.findUnique({ where: { slug: ORG_SLUG } });
  if (!org) throw new Error(`Org ${ORG_SLUG} not found`);

  const match = await db.match.findFirst({
    where: {
      activity: { orgId: org.id },
      date: { gte: new Date() },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
    },
    orderBy: { date: "asc" },
    include: { activity: { select: { name: true } } },
  });
  if (!match) throw new Error("No upcoming match found");
  console.log(`Target match: ${match.activity.name} on ${match.date.toISOString()} (max ${match.maxPlayers})`);

  // Load org members once.
  const members = await db.user.findMany({
    where: { memberships: { some: { orgId: org.id } } },
    select: { id: true, name: true, email: true, phoneNumber: true },
  });

  const startPosition =
    ((
      await db.attendance.aggregate({
        where: { matchId: match.id },
        _max: { position: true },
      })
    )._max.position ?? 0) + 1;

  let position = startPosition;
  let recorded = 0;
  for (const ident of IN_PLAYERS) {
    const needle = ident.trim();
    if (!needle) continue;
    let user: (typeof members)[number] | undefined;

    if (needle.includes("@")) {
      user = members.find((m) => m.email.toLowerCase() === needle.toLowerCase());
    }
    if (!user) {
      const norm = normalisePhone(needle);
      if (norm) user = members.find((m) => m.phoneNumber === norm);
    }
    if (!user) {
      // Case- and diacritic-insensitive partial match on name. Handles
      // "İdris" → "idris", "Ömer" → "omer", etc.
      const norm = (s: string) =>
        s
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "") // combining diacritics
          .replace(/ı/g, "i") // turkish dotless i
          .replace(/i̇/g, "i"); // turkish i with dot above as combining sequence
      const low = norm(needle);
      user = members.find((m) => norm(m.name ?? "").includes(low));
    }
    if (!user) {
      console.log(`  ⚠️  skipped: ${ident} (no member matched)`);
      continue;
    }

    const confirmedCount = await db.attendance.count({
      where: { matchId: match.id, status: "CONFIRMED" },
    });
    const status = confirmedCount < match.maxPlayers ? "CONFIRMED" : "BENCH";

    await db.attendance.upsert({
      where: { matchId_userId: { matchId: match.id, userId: user.id } },
      create: { matchId: match.id, userId: user.id, status, position: position++ },
      update: { status, position: position++, respondedAt: new Date() },
    });

    console.log(`  ✓  ${user.name ?? user.email} → ${status}`);
    recorded++;
  }

  console.log(`\nRecorded attendance for ${recorded}/${IN_PLAYERS.length} players.`);

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
