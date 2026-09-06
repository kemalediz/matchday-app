/**
 * READ-ONLY peek at the two org flags and the last few matches the §10
 * step 7 part 2 routes depend on, for the Sutton FC group.
 *
 * Every statement here is a `findFirst` / `findMany`. Nothing in this
 * file can write.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/peek-writeroutes-flags.ts
 */
import { db } from "../src/lib/db.ts";

const DEFAULT_GROUP = "447525334985-1607872139@g.us";

async function main(): Promise<void> {
const org = await db.organisation.findFirst({
  where: { whatsappGroupId: process.env.ORG_GROUP ?? DEFAULT_GROUP },
  select: {
    id: true,
    name: true,
    paymentTrackingEnabled: true,
    paymentCollectionEnabled: true,
    featureReminders: true,
    featureAttendance: true,
  },
});
console.log("ORG FLAGS:", org);

if (org) {
  const matches = await db.match.findMany({
    where: { activity: { orgId: org.id } },
    select: {
      id: true,
      date: true,
      status: true,
      redScore: true,
      yellowScore: true,
      isHistorical: true,
      activity: { select: { matchDurationMins: true } },
    },
    orderBy: { date: "desc" },
    take: 6,
  });
  console.log("LAST 6 MATCHES:");
  for (const m of matches) {
    const ended = new Date(m.date.getTime() + m.activity.matchDurationMins * 60_000);
    console.log(
      `  ${m.id}  ${m.date.toISOString()}  ${m.status.padEnd(16)} ` +
        `score=${m.redScore}-${m.yellowScore}  historical=${m.isHistorical}  ` +
        `ended=${ended <= new Date() ? "yes" : "no"}`,
    );
  }
}

await db.$disconnect();
}

void main();
