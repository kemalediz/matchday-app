/** The format switch to 5-a-side moved activityId and maxPlayers but left
 *  match.date at the 7-a-side kickoff (21:30). The 5-a-side activity is
 *  configured 21:15. Moves the match to its own activity's time.
 *  --apply to write. */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
const MATCH="cmtbro24b0002tt9keks8fscu";
const APPLY=process.argv.includes("--apply");
async function main(){
  const db=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL!})} as any);
  const m=await db.match.findUnique({where:{id:MATCH},select:{date:true,attendanceDeadline:true,activity:{select:{name:true,time:true,deadlineHours:true}}}});
  const [h,min]=m!.activity.time.split(":").map(Number);
  // Build the same calendar day in London at the activity's configured time.
  const londonDay=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/London"}).format(m!.date); // YYYY-MM-DD
  // London is BST (+1) on 8 Sept, so 21:15 London = 20:15Z. Derive the offset rather than assume.
  const probe=new Date(`${londonDay}T12:00:00Z`);
  const offsetMin=(new Date(probe.toLocaleString("en-US",{timeZone:"Europe/London"})).getTime()-new Date(probe.toLocaleString("en-US",{timeZone:"UTC"})).getTime())/60000;
  const target=new Date(`${londonDay}T${String(h).padStart(2,"0")}:${String(min).padStart(2,"0")}:00Z`);
  target.setUTCMinutes(target.getUTCMinutes()-offsetMin);
  console.log(`activity ${m!.activity.name} time=${m!.activity.time} (London offset ${offsetMin}m)`);
  console.log(`current : ${m!.date.toISOString()}  = ${m!.date.toLocaleString("en-GB",{timeZone:"Europe/London"})}`);
  console.log(`target  : ${target.toISOString()}  = ${target.toLocaleString("en-GB",{timeZone:"Europe/London"})}`);
  console.log(`deadline: ${(m as any).attendanceDeadline?.toLocaleString("en-GB",{timeZone:"Europe/London"})} (deadlineHours=${m!.activity.deadlineHours})`);
  if(!APPLY){ console.log("\nDRY RUN"); await db.$disconnect(); return; }
  const upd=await db.match.update({where:{id:MATCH},data:{date:target},select:{date:true}});
  console.log(`\nUPDATED -> ${upd.date.toLocaleString("en-GB",{timeZone:"Europe/London"})}`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
