/**
 * Read historical group messages and replay any IN/OUT activity the bot
 * missed while it was offline. Safe to run on every startup because the
 * server's attendance upsert is idempotent — re-processing the same "IN"
 * just re-confirms the player. No reactions or group replies are posted
 * during backfill (silent).
 *
 * Scope: messages since the Monday 00:00 London of the current week.
 *
 * Robustness:
 *   - Waits briefly after client ready for the WhatsApp Web page to
 *     hydrate the chat's message store — otherwise fetchMessages can fail
 *     with a puppeteer eval error.
 *   - Starts with a small limit and grows if needed so we don't OOM
 *     puppeteer on chats with many thousands of messages.
 *   - Retries once on transient failure.
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
  const londonNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Europe/London" }),
  );
  const dow = londonNow.getDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7;
  londonNow.setHours(0, 0, 0, 0);
  londonNow.setDate(londonNow.getDate() - daysSinceMonday);
  return londonNow;
}

async function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(
  chat: { fetchMessages: (opts: { limit: number }) => Promise<unknown[]> },
  limit: number,
): Promise<unknown[] | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return (await chat.fetchMessages({ limit })) as unknown[];
    } catch (err) {
      console.error(`  fetchMessages attempt ${attempt}/3 (limit ${limit}) failed:`, (err as Error)?.message ?? err);
      if (attempt < 3) await wait(3000 * attempt);
    }
  }
  return null;
}

export async function backfillMessagesForGroups(
  client: Client,
  groups: GroupConfig[],
  limit = 60,
): Promise<void> {
  const since = startOfThisMondayUTC();
  console.log(`Backfilling IN/OUT since ${since.toISOString()} across ${groups.length} group(s)…`);

  // WhatsApp Web hydrates chat stores lazily. Wait longer so the message
  // store is populated before we call fetchMessages — without this pause,
  // wweb.js's injected JS throws a puppeteer eval error.
  await wait(30_000);

  for (const g of groups) {
    try {
      const chat = await client.getChatById(g.groupId);

      // Touch lastMessage to nudge the Store, then wait again.
      void (chat as { lastMessage?: unknown }).lastMessage;
      await wait(3000);

      const messages = await fetchWithRetry(
        chat as unknown as { fetchMessages: (opts: { limit: number }) => Promise<unknown[]> },
        limit,
      );
      if (!messages) {
        console.log(`  [${g.orgName}] backfill skipped (fetchMessages failed after retries). Admin can replay manually via scripts/manual-backfill.ts.`);
        continue;
      }
      // newest-first → chronological
      messages.reverse();

      let processed = 0;
      let matched = 0;
      for (const raw of messages) {
        const m = raw as {
          body?: string;
          timestamp?: number;
          author?: string;
          from?: string;
          fromMe?: boolean;
        };
        if (!m.body) continue;
        if (m.fromMe) continue; // our own bot messages
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
          console.error(`  backfill: ${phone} ${action} failed:`, err);
        }
      }
      console.log(`  [${g.orgName}] scanned ${messages.length}, tried ${processed}, recorded ${matched} attendance upserts`);
    } catch (err) {
      console.error(`  [${g.orgName}] backfill failed:`, err);
    }
  }
}
