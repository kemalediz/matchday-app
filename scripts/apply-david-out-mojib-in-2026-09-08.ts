/** Match day 2026-09-08. Kemal in the group: "David is OUT voluntarily to
 *  switch to 5aside" and "@David ... out"; Mojib said "Il go bench" but is
 *  needed in the squad now David has gone. MatchTime never recorded either
 *  because the @-mention arrived corrupted from the WhatsApp layer.
 *  --apply to write. */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { cancelAttendance, registerAttendance } from "../src/lib/attendance.ts";
const MATCH="cmtbro24b0002tt9keks8fscu";
const DAVID="cmppvwmmu000004l1bgzp983q", MOJIB="cmo4wnnrd000bmvr8nujqxj49", KEMAL="cmn5vhtp2000004ifh4dqbsym";
const APPLY=process.argv.includes("--apply");
const ev=(note:string)=>({cause:"admin-message" as const,actorKind:"admin" as const,actorUserId:KEMAL,sourceRef:"scripts/apply-david-out-mojib-in-2026-09-08.ts",note});
async function show(db:any,label:string){
  const rows=await db.attendance.findMany({where:{matchId:MATCH},select:{status:true,position:true,user:{select:{name:true}}},orderBy:{position:"asc"}});
  const c=rows.filter((a:any)=>a.status==="CONFIRMED");
  console.log(`\n${label}: ${c.length}/10 confirmed`);
  for(const a of rows) console.log(`   ${String(a.position).padStart(2)}. ${a.status.padEnd(9)} ${a.user.name}`);
}
async function main(){
  const db=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL!})} as any);
  await show(db,"BEFORE");
  if(!APPLY){ console.log("\nDRY RUN — would: DROP David, then promote Mojib from bench into the squad"); await db.$disconnect(); return; }
  await cancelAttendance(DAVID, MATCH, ev("David out voluntarily so the match could switch to 5-a-side (group, 08:04). Not recorded live: the @-mention arrived corrupted from the WhatsApp layer.") as any);
  await registerAttendance(MOJIB, MATCH, { promoteFromBench:true, event: ev("Mojib takes the slot David vacated. He offered the bench at 08:05; with David gone he is needed in the squad.") } as any);
  await show(db,"AFTER");
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
