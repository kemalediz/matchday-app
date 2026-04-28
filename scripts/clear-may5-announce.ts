/**
 * Delete the SentNotification row for the May 5 match's announce-match
 * key. The bot fired it prematurely at 01:20 BST on Apr 28 because the
 * old code had no time-of-day gate; Kemal removed the message manually
 * from the group. Clearing the dedup row lets the (now-fixed)
 * 09:00-13:00 London window fire a proper morning announcement on
 * Apr 29 once tonight's Apr 28 match has completed.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  const may5 = await db.match.findFirst({
    where: { isHistorical: false, status: "UPCOMING" },
    orderBy: { date: "desc" },
    select: { id: true, date: true },
  });
  if (!may5) {
    console.log("No upcoming match found.");
    return;
  }
  console.log(`Target match: ${may5.id} (${may5.date.toISOString()})`);

  const key = `${may5.id}:announce-match`;
  const existing = await db.sentNotification.findUnique({ where: { key } });
  if (!existing) {
    console.log(`No SentNotification with key ${key} — nothing to delete.`);
    return;
  }
  console.log(`Found SN ${existing.id} created ${existing.createdAt.toISOString()}`);

  await db.sentNotification.delete({ where: { key } });
  console.log(`Deleted. Bot will now re-emit announce-match in the next 09:00-13:00 BST window after the Apr 28 match completes.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => process.exit(0));
