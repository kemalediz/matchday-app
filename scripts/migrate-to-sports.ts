/**
 * One-off migration: move from the (now-removed) User.positions global field
 * and Activity.format/Match.format enums to the new Sport-backed model.
 *
 * Preconditions (must have been run before this script):
 *   - Prisma schema has been pushed to add Sport + PlayerActivityPosition
 *     and drop User.positions, Activity.format, Match.format.
 *
 * What this script does:
 *   1. For each Organisation, create a Sport record per preset (library).
 *   2. For every existing Activity, assign it to the matching preset Sport
 *      based on the original format hint — we know Sutton FC only has
 *      football activities so Football 7-a-side or Football 5-a-side.
 *   3. Seed PlayerActivityPosition for every user with the positions they
 *      had in the rebuild source (kept here as a static list since the DB
 *      column was dropped before this migration ran). Users get positions
 *      for the *primary* active activity of their org.
 *
 * Idempotent: safe to re-run; will skip any Sport / assignment / position
 * row that already exists.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { SPORT_PRESETS } from "../src/lib/sport-presets.ts";

// Player positions snapshot — lifted from scripts/rebuild-sutton.ts which
// was the canonical source before the Prisma column was dropped.
const PLAYER_POSITIONS: Record<string, string[]> = {
  "kemal.ediz@cressoft.io":      ["GK", "MID"],
  "sait@matchday.local":         ["MID"],
  "elvin@matchday.local":        ["MID", "FWD"],
  "baki@matchday.local":         ["MID", "FWD"],
  "wasim@matchday.local":        ["MID", "FWD"],
  "ersin@matchday.local":        ["GK"],
  "mojib@matchday.local":        ["MID", "DEF"],
  "ehtisham@matchday.local":     ["MID"],
  "ali@matchday.local":          ["DEF"],
  "idris@matchday.local":        ["DEF"],
  "mustafa@matchday.local":      ["MID", "FWD"],
  "aytekin@matchday.local":      ["DEF"],
  "zair@matchday.local":         ["FWD"],
  "elnur@matchday.local":        ["MID", "FWD"],
  "omar@matchday.local":         ["MID", "GK"],
  "abid@matchday.local":         ["MID"],
  "ilkay@matchday.local":        ["MID", "FWD"],
  "mauricio@matchday.local":     ["MID"],
  "enayem@matchday.local":       ["MID"],
  "fatih@matchday.local":        ["DEF"],
  "ibrahim@matchday.local":      ["MID"],
  "amir@matchday.local":         ["MID"],
  "najib@matchday.local":        ["MID", "DEF"],
  "hasan@matchday.local":        ["DEF", "MID"],
  "erdal@matchday.local":        ["FWD", "MID"],
  "mehmet-unal@matchday.local":  ["MID", "FWD"],
  "aykut@matchday.local":        ["MID", "FWD"],
  "ersan@matchday.local":        ["FWD", "MID"],
  "burak@matchday.local":        ["FWD", "MID"],
  "yusuf@matchday.local":        ["MID"],
  "akin@matchday.local":         ["GK"],
  "recai@matchday.local":        ["MID", "FWD"],
  "michael@matchday.local":      ["MID", "FWD"],
  "eren@matchday.local":         ["FWD", "MID"],
};

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  // 1. Build Sport library per org.
  const orgs = await db.organisation.findMany();
  const sportsByOrg = new Map<string, Map<string, { id: string }>>();

  for (const org of orgs) {
    const byKey = new Map<string, { id: string }>();
    for (const preset of SPORT_PRESETS) {
      const existing = await db.sport.findFirst({
        where: { orgId: org.id, preset: preset.key },
      });
      if (existing) {
        byKey.set(preset.key, { id: existing.id });
        continue;
      }
      const created = await db.sport.create({
        data: {
          orgId: org.id,
          preset: preset.key,
          name: preset.name,
          playersPerTeam: preset.playersPerTeam,
          positions: preset.positions,
          teamLabels: preset.teamLabels,
          mvpLabel: preset.mvpLabel,
          balancingStrategy: preset.balancingStrategy,
          positionComposition: preset.positionComposition ?? null,
        },
      });
      byKey.set(preset.key, { id: created.id });
    }
    sportsByOrg.set(org.id, byKey);
    console.log(`Org ${org.slug}: seeded ${byKey.size} sport presets`);
  }

  // 2. Point each Activity at a Sport. Without the old `format` column we
  //    infer from the activity name — "5-a-side" in name → football-5aside,
  //    otherwise default to football-7aside.
  const activities = await db.activity.findMany();
  for (const a of activities) {
    if (a.sportId) continue; // already linked
    const orgSports = sportsByOrg.get(a.orgId);
    if (!orgSports) continue;
    const is5 = /5[ -]?a[ -]?side/i.test(a.name);
    const targetKey = is5 ? "football-5aside" : "football-7aside";
    const sport = orgSports.get(targetKey);
    if (!sport) continue;
    await db.activity.update({
      where: { id: a.id },
      data: { sportId: sport.id },
    });
    console.log(`  linked activity "${a.name}" -> ${targetKey}`);
  }

  // 3. Seed PlayerActivityPosition for every known user against the primary
  //    active Activity of their org (for Sutton FC: Tuesday 7-a-side).
  for (const org of orgs) {
    const primary = await db.activity.findFirst({
      where: { orgId: org.id, isActive: true },
      orderBy: { createdAt: "asc" },
    });
    if (!primary) {
      console.log(`Org ${org.slug}: no active activity, skipping position seed`);
      continue;
    }
    const members = await db.membership.findMany({
      where: { orgId: org.id },
      include: { user: { select: { email: true, id: true, name: true } } },
    });
    let seeded = 0;
    for (const m of members) {
      const positions = PLAYER_POSITIONS[m.user.email];
      if (!positions) {
        console.log(`  no position data for ${m.user.email}, skipping`);
        continue;
      }
      await db.playerActivityPosition.upsert({
        where: { userId_activityId: { userId: m.user.id, activityId: primary.id } },
        create: { userId: m.user.id, activityId: primary.id, positions },
        update: { positions },
      });
      seeded++;
    }
    console.log(`Org ${org.slug}: seeded ${seeded} PlayerActivityPosition rows for "${primary.name}"`);
  }

  // Sanity check: how many activities still have no sport?
  const orphanActivities = await db.activity.count({ where: { sportId: null } });
  console.log(`\nActivities without a sport: ${orphanActivities} (should be 0)`);

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
