/** Shahrokh's @lid mention resolves to the pushname "DÇ", which matches
 *  no member. Adds the admin-curated alias so a mention of him names him.
 *  --apply to write. */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { normaliseName } from "../src/lib/name-normalise.ts";
const ORG="cmnnwhdx30000zfr85q18lyy9", SHAHROKH="cmtgcwh4c000504jsjm3bz98f", PUSHNAME="DÇ";
const APPLY=process.argv.includes("--apply");
async function main(){
  const db=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL!})} as any);
  const key=normaliseName(PUSHNAME);
  console.log(`pushname ${JSON.stringify(PUSHNAME)} normalises to key ${JSON.stringify(key)}`);
  const clash=await db.userAlias.findUnique({where:{orgId_alias:{orgId:ORG,alias:key}},include:{user:{select:{name:true}}}});
  console.log(`existing alias for that key: ${clash?clash.user.name:"none"}`);
  const memberClash=await db.membership.findMany({where:{orgId:ORG},select:{user:{select:{id:true,name:true}}}});
  const nameClash=memberClash.filter((m:any)=>normaliseName(m.user.name??"")===key);
  console.log(`members whose own name normalises to that key: ${nameClash.length?nameClash.map((m:any)=>m.user.name).join(", "):"none"}`);
  if(!APPLY){ console.log("\nDRY RUN — would create alias -> Shahrokh"); await db.$disconnect(); return; }
  if(clash||nameClash.length){ console.log("REFUSING: key already claimed"); await db.$disconnect(); return; }
  const a=await db.userAlias.create({data:{userId:SHAHROKH,orgId:ORG,alias:key,source:"manual"}});
  console.log(`created alias ${JSON.stringify(a.alias)} -> Shahrokh (source=manual)`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
