/** One-off: Kemal reported Shahrokh out for Tue 8 Sept at 21:11 on
 *  2026-09-07. The message named the player but not MatchTime, so the
 *  contract's tag rule meant nothing was recorded. --apply to write. */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { cancelAttendance } from "../src/lib/attendance.ts";
const MATCH="cmtbro24b0002tt9keks8fscu", SHAHROKH="cmtgcwh4c000504jsjm3bz98f";
const APPLY=process.argv.includes("--apply");
async function main(){
  const db=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL!})} as any);
  const rows=await db.attendance.findMany({where:{matchId:MATCH},select:{status:true,position:true,user:{select:{id:true,name:true}}},orderBy:{position:"asc"}});
  console.log(`BEFORE: ${rows.filter((a:any)=>a.status==="CONFIRMED").length} confirmed, ${rows.filter((a:any)=>a.status==="BENCH").length} bench`);
  const s=rows.find((a:any)=>a.user.id===SHAHROKH);
  console.log(`Shahrokh: ${s?`${s.status} at position ${s.position}`:"NOT IN THE MATCH"}`);
  if(!APPLY){ console.log("\nDRY RUN — would register Shahrokh OUT"); await db.$disconnect(); return; }
  await cancelAttendance(SHAHROKH, MATCH, { cause:"admin-message", actorKind:"admin", actorUserId:"cmn5vhtp2000004ifh4dqbsym", sourceRef:"scripts/drop-shahrokh-2026-09-07.ts", note:"Kemal in the group 21:11: reported Shahrokh out for work. MatchTime did not act: the message named the player but not the bot" } as any);
  const after=await db.attendance.findMany({where:{matchId:MATCH,status:"CONFIRMED"},select:{user:{select:{name:true}}}});
  console.log(`\nAFTER: ${after.length}/14 confirmed`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
