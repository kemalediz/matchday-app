import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("Seeding database...");

  // Create default org
  const org = await prisma.organisation.upsert({
    where: { slug: "sutton-fc" },
    update: {},
    create: {
      name: "Sutton Football Club",
      slug: "sutton-fc",
    },
  });
  console.log(`Created org: ${org.name}`);

  // Create activities
  const tuesday7aside = await prisma.activity.upsert({
    where: { id: "tuesday-7aside" },
    update: {},
    create: {
      id: "tuesday-7aside",
      orgId: org.id,
      name: "Tuesday 7-a-side",
      dayOfWeek: 2,
      time: "21:30",
      venue: "Goals North Cheam",
      format: "SEVEN_A_SIDE",
      deadlineHours: 5,
      ratingWindowHours: 48,
    },
  });
  console.log(`Created activity: ${tuesday7aside.name}`);

  const tuesday5aside = await prisma.activity.upsert({
    where: { id: "tuesday-5aside" },
    update: {},
    create: {
      id: "tuesday-5aside",
      orgId: org.id,
      name: "Tuesday 5-a-side",
      dayOfWeek: 2,
      time: "21:30",
      venue: "Goals North Cheam",
      format: "FIVE_A_SIDE",
      deadlineHours: 5,
      ratingWindowHours: 48,
      isActive: false,
    },
  });
  console.log(`Created activity: ${tuesday5aside.name}`);

  // Seed known players
  type P = "GK" | "DEF" | "MID" | "FWD";
  const players: { name: string; email: string; positions: P[]; seedRating: number }[] = [
    { name: "Kemal Ediz", email: "kemal@matchday.local", positions: ["GK", "MID"], seedRating: 6.5 },
    { name: "Elvin Azeri", email: "elvin@matchday.local", positions: ["MID", "FWD"], seedRating: 7.0 },
    { name: "Wasim", email: "wasim@matchday.local", positions: ["MID", "FWD"], seedRating: 7.0 },
    { name: "Hasan Altun", email: "hasan@matchday.local", positions: ["DEF", "MID"], seedRating: 6.5 },
    { name: "Recai Gunay", email: "recai@matchday.local", positions: ["MID", "FWD"], seedRating: 6.0 },
    { name: "Idris Y", email: "idris@matchday.local", positions: ["DEF"], seedRating: 6.0 },
    { name: "Mustafa Cayir", email: "mustafa@matchday.local", positions: ["MID", "FWD"], seedRating: 6.5 },
    { name: "Sait", email: "sait@matchday.local", positions: ["MID"], seedRating: 6.0 },
    { name: "Ilkay", email: "ilkay@matchday.local", positions: ["MID", "FWD"], seedRating: 6.5 },
    { name: "Ersan Arik", email: "ersan@matchday.local", positions: ["FWD", "MID"], seedRating: 7.0 },
    { name: "Zair", email: "zair@matchday.local", positions: ["DEF", "MID"], seedRating: 6.0 },
    { name: "Michael Allen", email: "michael@matchday.local", positions: ["MID", "FWD"], seedRating: 6.0 },
    { name: "Elnur Mammadov", email: "elnur@matchday.local", positions: ["MID", "FWD"], seedRating: 6.5 },
  ];

  for (const player of players) {
    const user = await prisma.user.upsert({
      where: { email: player.email },
      update: { name: player.name, positions: player.positions, seedRating: player.seedRating },
      create: {
        name: player.name,
        email: player.email,
        positions: player.positions,
        seedRating: player.seedRating,
        onboarded: true,
      },
    });

    // Create membership
    await prisma.membership.upsert({
      where: { userId_orgId: { userId: user.id, orgId: org.id } },
      update: {},
      create: {
        userId: user.id,
        orgId: org.id,
        role: player.email === "kemal@matchday.local" ? "OWNER" : "PLAYER",
      },
    });
  }
  console.log(`Seeded ${players.length} players with memberships`);

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
