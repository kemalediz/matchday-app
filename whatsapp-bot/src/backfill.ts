/**
 * Read historical group messages and replay any IN/OUT activity the bot
 * missed while it was offline. Safe to run on every startup because the
 * server's attendance upsert is idempotent — re-processing the same "IN"
 * just re-confirms the player. No reactions or group replies are posted
 * during backfill (silent).
 *
 * Scope: messages since the Monday 00:00 London of the current week (or
 * `backfillDays` earlier if specified). Most recent 500 messages fetched
 * and filtered — whatsapp-web.js's fetchMessages returns newest first, so
 * we reverse before processing to preserve chronological attendance order.
 */
import pkg from "whatsapp-web.js";
import { extract } from "./handlers.js";
import { postAttendance } from "./api.js";

type Client = InstanceType<typeof pkg.Client>;

interface GroupConfig {
  groupId: string;
  orgName: string;
}

function startOfThisMondayUTC(): Date {
  // Compute Monday 00:00 Europe/London for the current week, in UTC.
  const now = new Date();
  // Work out the UK weekday of `now` using Intl.
  const ukDow = parseInt(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      weekday: "narrow", // we don't use this — we use getDay() on the local view
    }).format(now),
    10,
  );
  // Simpler: compute locale string, derive date, subtract days.
  const londonNow = new Date(
    now.toLocaleString("en-US", { timeZone: "Europe/London" }),
  );
  const dow = londonNow.getDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7; // Sun=6, Mon=0, Tue=1, ..., Sat=5
  londonNow.setHours(0, 0, 0, 0);
  londonNow.setDate(londonNow.getDate() - daysSinceMonday);
  void ukDow; // quiet the unused-var warning
  return londonNow;
}

export async function backfillMessagesForGroups(
  client: Client,
  groups: GroupConfig[],
  maxMessages = 500,
): Promise<void> {
  const since = startOfThisMondayUTC();
  console.log(`Backfilling IN/OUT since ${since.toISOString()} across ${groups.length} group(s)…`);

  for (const g of groups) {
    try {
      const chat = await client.getChatById(g.groupId);
      const messages = await chat.fetchMessages({ limit: maxMessages });
      // newest-first → chronological (oldest first)
      messages.reverse();

      let processed = 0;
      let matched = 0;
      for (const m of messages) {
        if (!m.body) continue;
        const ts = new Date((m.timestamp ?? 0) * 1000);
        if (ts < since) continue;

        const action = extract(m.body);
        if (!action) continue;

        const authorId: string | undefined = m.author ?? (typeof m.from === "string" ? m.from : undefined);
        if (!authorId) continue;
        const phone = "+" + authorId.replace("@c.us", "");

        try {
          const result = await postAttendance(phone, action, g.groupId);
          processed++;
          if (!result.error) matched++;
        } catch (err) {
          // Keep going — one failure shouldn't block the whole backfill.
          console.error(`backfill: ${phone} ${action} failed:`, err);
        }
      }
      console.log(`  [${g.orgName}] scanned ${messages.length}, tried ${processed}, recorded ${matched} attendance upserts`);
    } catch (err) {
      console.error(`  [${g.orgName}] backfill failed:`, err);
    }
  }
}
