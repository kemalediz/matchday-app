/** Elvin dropped at 15:25 but still held a RED slot; Raihan came in as his
 *  replacement with no slot. Kemal asked MatchTime to swap them at 16:47 and
 *  it could not: handleTeamSwapIfApplicable requires BOTH players CONFIRMED.
 *  Transfers the slot, same shape as bench-confirmation.ts. --apply to write. */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
const MATCH="cmtbro24b0002tt9keks8fscu";
const APPLY=process.argv.includes("--apply");
async function main(){
  const db=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL!})} as any);
  const roster=await db.membership.findMany({where:{orgId:"cmnnwhdx30000zfr85q18lyy9"},select:{user:{select:{id:true,name:true}}}});
  const find=(n:string)=>roster.find((r:any)=>(r.user.name??"").toLowerCase()===n.toLowerCase())?.user;
  const elvin=find("Elvin"), raihan=find("Raihan");
  if(!elvin||!raihan) throw new Error("name did not resolve");
  const ta=await db.teamAssignment.findUnique({where:{matchId_userId:{matchId:MATCH,userId:elvin.id}}});
  const rTa=await db.teamAssignment.findUnique({where:{matchId_userId:{matchId:MATCH,userId:raihan.id}}});
  console.log(`Elvin  slot: ${ta?ta.team:"none"}   Raihan slot: ${rTa?rTa.team:"none"}`);
  if(!ta){ console.log("nothing to transfer"); await db.$disconnect(); return; }
  if(!APPLY){ console.log(`\nDRY RUN — would move ${ta.team} from Elvin to Raihan`); await db.$disconnect(); return; }
  await db.$transaction([
    db.teamAssignment.delete({where:{matchId_userId:{matchId:MATCH,userId:elvin.id}}}),
    db.teamAssignment.upsert({where:{matchId_userId:{matchId:MATCH,userId:raihan.id}},create:{matchId:MATCH,userId:raihan.id,team:ta.team},update:{team:ta.team}}),
  ]);
  const after=await db.teamAssignment.findMany({where:{matchId:MATCH},select:{team:true,user:{select:{name:true}}}});
  console.log(`\nAFTER (${after.length}):`);
  for(const t of after as any[]) console.log(`   ${t.team.padEnd(6)} ${t.user.name}`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
