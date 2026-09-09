/** Posts the kickoff correction (21:30 -> 21:15) plus the line-up Kemal
 *  asked for at 16:47 that MatchTime never delivered. Claim-on-dispatch:
 *  the SentNotification key is written in the same transaction as the
 *  BotJob, so a retry cannot double-post. --apply to send. */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { formatTeamsPost } from "../src/lib/group-copy.ts";
import { resolveTeamLabels } from "../src/lib/team-labels.ts";
const MATCH="cmtbro24b0002tt9keks8fscu", ORG="cmnnwhdx30000zfr85q18lyy9";
const KEY=`${MATCH}:kickoff-correction:2026-09-08`;
const APPLY=process.argv.includes("--apply");
async function main(){
  const db=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL!})} as any);
  const m=await db.match.findUnique({where:{id:MATCH},select:{date:true,teamLabels:true,activity:{select:{venue:true,org:{select:{teamLabels:true}},sport:{select:{teamLabels:true}}}}},});
  const tas=await db.teamAssignment.findMany({where:{matchId:MATCH},select:{team:true,user:{select:{name:true}}}});
  const labels=resolveTeamLabels(m as any,(m!.activity as any).org,(m!.activity as any).sport);
  const kickoff=m!.date.toLocaleTimeString("en-GB",{timeZone:"Europe/London",hour:"2-digit",minute:"2-digit"});
  const teams=formatTeamsPost({
    redLabel:labels[0], yellowLabel:labels[1],
    red:tas.filter((t:any)=>t.team==="RED").map((t:any)=>({name:t.user.name})),
    yellow:tas.filter((t:any)=>t.team==="YELLOW").map((t:any)=>({name:t.user.name})),
    kickoff, venue:m!.activity.venue,
  });
  const text=`⏰ *Correction — kickoff is 21:15 tonight, not 21:30.* The 5-a-side starts 15 minutes earlier than the 7-a-side.\n\n${teams}`;
  console.log(text);
  if(!APPLY){ console.log("\n--- DRY RUN ---"); await db.$disconnect(); return; }
  const dup=await db.sentNotification.findUnique({where:{key:KEY}});
  if(dup){ console.log("\nALREADY SENT — refusing to duplicate"); await db.$disconnect(); return; }
  await db.$transaction([
    db.sentNotification.create({data:{key:KEY,kind:"group"}}),
    db.botJob.create({data:{orgId:ORG,kind:"group",text}}),
  ]);
  console.log("\nQUEUED (claim-on-dispatch).");
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
