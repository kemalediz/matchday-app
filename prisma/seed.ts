import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("Seeding database...");

  // Create activities
  const tuesday7aside = await prisma.activity.upsert({
    where: { id: "tuesday-7aside" },
    update: {},
    create: {
      id: "tuesday-7aside",
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
  type R = "ADMIN" | "PLAYER";
  const players: { name: string; email: string; positions: P[]; role: R; seedRating: number }[] = [
    { name: "Kemal Ediz", email: "kemal@matchday.local", positions: ["GK", "MID"], role: "ADMIN", seedRating: 6.5 },
    { name: "Elvin Azeri", email: "elvin@matchday.local", positions: ["MID", "FWD"], role: "ADMIN", seedRating: 7.0 },
    { name: "Wasim", email: "wasim@matchday.local", positions: ["MID", "FWD"], role: "PLAYER", seedRating: 7.0 },
    { name: "Hasan Altun", email: "hasan@matchday.local", positions: ["DEF", "MID"], role: "PLAYER", seedRating: 6.5 },
    { name: "Recai Gunay", email: "recai@matchday.local", positions: ["MID", "FWD"], role: "PLAYER", seedRating: 6.0 },
    { name: "Idris Y", email: "idris@matchday.local", positions: ["DEF"], role: "PLAYER", seedRating: 6.0 },
    { name: "Mustafa Cayir", email: "mustafa@matchday.local", positions: ["MID", "FWD"], role: "PLAYER", seedRating: 6.5 },
    { name: "Sait", email: "sait@matchday.local", positions: ["MID"], role: "PLAYER", seedRating: 6.0 },
    { name: "Ilkay", email: "ilkay@matchday.local", positions: ["MID", "FWD"], role: "PLAYER", seedRating: 6.5 },
    { name: "Ersan Arik", email: "ersan@matchday.local", positions: ["FWD", "MID"], role: "PLAYER", seedRating: 7.0 },
    { name: "Zair", email: "zair@matchday.local", positions: ["DEF", "MID"], role: "PLAYER", seedRating: 6.0 },
    { name: "Michael Allen", email: "michael@matchday.local", positions: ["MID", "FWD"], role: "PLAYER", seedRating: 6.0 },
    { name: "Elnur Mammadov", email: "elnur@matchday.local", positions: ["MID", "FWD"], role: "PLAYER", seedRating: 6.5 },
    { name: "Mojib", email: "mojib@matchday.local", positions: ["MID", "DEF"], role: "PLAYER", seedRating: 5.5 },
    { name: "Omar", email: "omar@matchday.local", positions: ["MID", "GK"], role: "PLAYER", seedRating: 6.0 },
    { name: "Baki", email: "baki@matchday.local", positions: ["MID", "FWD"], role: "PLAYER", seedRating: 6.5 },
    { name: "Fatih Incefidan", email: "fatih@matchday.local", positions: ["MID"], role: "PLAYER", seedRating: 6.0 },
    { name: "Burak Yildiz", email: "burak@matchday.local", positions: ["FWD", "MID"], role: "PLAYER", seedRating: 6.0 },
    { name: "Ersin Sevindik", email: "ersin@matchday.local", positions: ["GK"], role: "PLAYER", seedRating: 6.5 },
    { name: "Akin", email: "akin@matchday.local", positions: ["GK"], role: "PLAYER", seedRating: 6.0 },
    { name: "Ali", email: "ali@matchday.local", positions: ["DEF"], role: "PLAYER", seedRating: 7.0 },
    { name: "Muharrem Arslan", email: "muharrem@matchday.local", positions: ["MID", "DEF"], role: "PLAYER", seedRating: 6.0 },
    { name: "Merdan Parahat", email: "merdan@matchday.local", positions: ["MID", "FWD"], role: "PLAYER", seedRating: 6.5 },
    { name: "Habib", email: "habib@matchday.local", positions: ["MID"], role: "PLAYER", seedRating: 5.5 },
    { name: "Eren", email: "eren@matchday.local", positions: ["FWD", "MID"], role: "PLAYER", seedRating: 6.5 },
    { name: "Hakan U", email: "hakan@matchday.local", positions: ["MID", "DEF"], role: "PLAYER", seedRating: 6.0 },
    { name: "Ozgur", email: "ozgur@matchday.local", positions: ["MID"], role: "PLAYER", seedRating: 6.0 },
    { name: "Fabrizio", email: "fab@matchday.local", positions: ["MID", "FWD"], role: "PLAYER", seedRating: 6.0 },
    { name: "Erdal", email: "erdal@matchday.local", positions: ["FWD", "MID"], role: "PLAYER", seedRating: 6.0 },
    { name: "Aykut Arsoy", email: "aykut@matchday.local", positions: ["MID"], role: "PLAYER", seedRating: 6.0 },
  ];

  for (const player of players) {
    await prisma.user.upsert({
      where: { email: player.email },
      update: { name: player.name, positions: player.positions, seedRating: player.seedRating, role: player.role },
      create: {
        name: player.name,
        email: player.email,
        positions: player.positions,
        seedRating: player.seedRating,
        role: player.role,
        onboarded: true,
      },
    });
  }
  console.log(`Seeded ${players.length} players`);

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
