/**
 * One-off: restore the INs said in the Sutton FC group while MatchTime
 * was muted on 2026-09-06. The Pi records message LENGTHS but never
 * bodies, so these could not be recovered from the log — the names came
 * from Kemal directly. Writes through `registerAttendance` so slot
 * ordering, capacity and the AttendanceEvent log all behave normally.
 * --apply to write; default is a dry run.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { registerAttendance } from "../src/lib/attendance.ts";

const MATCH = "cmtbro24b0002tt9keks8fscu"; // Tue 8 Sept 21:30
const ADD: Array<[string, string]> = [
  ["cmo4wnniq0003mvr8ocgt474y", "Elvin"],
  ["cmo67q1ht00003zr8yoovlqbe", "Habib"],
  ["cmo4wno9x000tmvr85cgvsira", "Abid Kazmi"],
  ["cmtgcwh4c000504jsjm3bz98f", "Shahrokh"],
  ["cmqzbbc3p00004c9kle7mppfc", "Kieran"],
  ["cmo4wnnrd000bmvr8nujqxj49", "Mojib"],
];
const APPLY = process.argv.includes("--apply");

async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const before = await db.attendance.findMany({ where: { matchId: MATCH }, select: { userId: true, status: true, user: { select: { name: true } } }, orderBy: { position: "asc" } });
  console.log(`BEFORE — ${before.filter((a: any) => a.status === "CONFIRMED").length}/14 confirmed`);
  for (const a of before) console.log(`   ${a.status.padEnd(9)} ${a.user.name}`);

  console.log(`\n${APPLY ? "APPLYING" : "DRY RUN"} — adding ${ADD.length}:`);
  for (const [uid, name] of ADD) {
    const existing = before.find((a: any) => a.userId === uid);
    if (existing) { console.log(`   SKIP ${name} — already ${existing.status}`); continue; }
    if (!APPLY) { console.log(`   would register ${name}`); continue; }
    await registerAttendance(uid, MATCH, {
      event: {
        cause: "maintenance-script",
        actorKind: "script",
        sourceRef: "scripts/backfill-mute-gap-2026-09-06.ts",
        note: "said IN in the group on 2026-09-06 while MatchTime was muted; names supplied by Kemal, message bodies are not retained on the Pi",
      },
    } as any);
    console.log(`   registered ${name}`);
  }

  const after = await db.attendance.findMany({ where: { matchId: MATCH }, select: { status: true, position: true, user: { select: { name: true } } }, orderBy: { position: "asc" } });
  const conf = after.filter((a: any) => a.status === "CONFIRMED");
  console.log(`\nAFTER — ${conf.length}/14 confirmed`);
  for (const a of after) console.log(`   ${String(a.position).padStart(2)}. ${a.status.padEnd(9)} ${a.user.name}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
