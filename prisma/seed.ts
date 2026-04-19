/**
 * Initial seed.
 *
 * For new orgs: seeds the 9 preset sports (Football 7/11/5, Futsal, Basketball
 * 5v5/3v3, Netball, Volleyball, Cricket) as a starting Sport library, then
 * creates a Tuesday 7-a-side football activity as an example.
 *
 * For ad-hoc rebuilds of the Sutton FC data (wipe + re-seed players from the
 * WhatsApp chat analysis), use `scripts/rebuild-sutton.ts` instead — it's the
 * canonical source and the one that gets re-run whenever the dataset changes.
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { SPORT_PRESETS } from "../src/lib/sport-presets";

const adapter = new PrismaPg({
  connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL,
});
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("Seeding database…");

  const org = await prisma.organisation.upsert({
    where: { slug: "sutton-fc" },
    update: {},
    create: { name: "Sutton Football Club", slug: "sutton-fc" },
  });
  console.log(`Org: ${org.name}`);

  // Sport library
  const sportByKey = new Map<string, { id: string }>();
  for (const p of SPORT_PRESETS) {
    const existing = await prisma.sport.findFirst({
      where: { orgId: org.id, preset: p.key },
    });
    if (existing) {
      sportByKey.set(p.key, existing);
      continue;
    }
    const created = await prisma.sport.create({
      data: {
        orgId: org.id,
        preset: p.key,
        name: p.name,
        playersPerTeam: p.playersPerTeam,
        positions: p.positions,
        teamLabels: [...p.teamLabels],
        mvpLabel: p.mvpLabel,
        balancingStrategy: p.balancingStrategy,
        positionComposition: p.positionComposition ?? undefined,
      },
    });
    sportByKey.set(p.key, created);
  }
  console.log(`Seeded ${sportByKey.size} sport presets`);

  // Example activity
  const football7 = sportByKey.get("football-7aside")!;
  await prisma.activity.upsert({
    where: { id: "tuesday-7aside" },
    update: { sportId: football7.id },
    create: {
      id: "tuesday-7aside",
      orgId: org.id,
      sportId: football7.id,
      name: "Tuesday 7-a-side",
      dayOfWeek: 2,
      time: "21:30",
      venue: "Goals North Cheam",
      deadlineHours: 5,
      ratingWindowHours: 48,
    },
  });

  console.log("Done!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
