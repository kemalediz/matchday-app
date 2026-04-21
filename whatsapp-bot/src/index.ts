import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode-terminal";
import { handleMessage, setMonitoredGroups, isMonitoredGroup } from "./handlers.js";
import { initScheduler, stopScheduler } from "./scheduler.js";
import {
  getEnabledOrgs,
  postReaction,
  postPollVote,
  postGroupJoin,
  postGroupLeave,
} from "./api.js";
import { backfillMessagesForGroups } from "./backfill.js";
import {
  enqueueForAnalysis,
  recordHistory,
  startBatchFlushTimer,
  stopBatchFlushTimer,
} from "./smart-analysis.js";
import { config } from "./config.js";

async function main() {
  console.log("MatchTime WhatsApp Bot starting...");
  console.log(`API URL: ${config.apiUrl}`);

  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });

  client.on("qr", (qr: string) => {
    console.log("\nScan this QR code with WhatsApp on the burner phone:\n");
    qrcode.generate(qr, { small: true });
  });

  client.on("ready", async () => {
    console.log("\nWhatsApp bot is ready!");

    try {
      const chats = await client.getChats();
      const groups = chats.filter((c) => c.isGroup);
      console.log(`\n=== Groups this account is a member of (${groups.length}) ===`);
      groups.forEach((g) => {
        console.log(`  ${g.id._serialized}   "${g.name}"`);
      });
      console.log(`=== end groups ===\n`);
    } catch (err) {
      console.error("Failed to enumerate groups:", err);
    }

    try {
      const data = await getEnabledOrgs();
      const orgConfigs = (data.orgs || [])
        .filter((o: { whatsappGroupId: string | null }) => o.whatsappGroupId)
        .map((o: { whatsappGroupId: string; name: string }) => ({
          groupId: o.whatsappGroupId,
          orgName: o.name,
        }));

      setMonitoredGroups(orgConfigs.map((o: { groupId: string }) => o.groupId));

      console.log(`Monitoring ${orgConfigs.length} group(s):`);
      orgConfigs.forEach((o: { orgName: string; groupId: string }) =>
        console.log(`  - ${o.orgName} (${o.groupId})`),
      );

      // Catch up on any IN/OUT messages posted while the bot was offline
      // (or before it was enabled). Silent — no reactions, no replies.
      await backfillMessagesForGroups(client, orgConfigs);

      initScheduler(client, orgConfigs);

      // Start the batch-flush timer. Anything the regex fast-path
      // doesn't handle gets buffered in-memory per group and flushed
      // every 10 minutes (or immediately when the next match is within
      // an hour of kickoff, or when the buffer hits MAX_BUFFER).
      startBatchFlushTimer(
        client,
        orgConfigs.map((o: { groupId: string }) => o.groupId),
      );
    } catch (err) {
      console.error("Failed to fetch org configs:", err);
    }
  });

  // Inbound group messages — IN/OUT detection.
  client.on(
    "message",
    async (msg) => {
      // WhatsApp pushname — the sender's self-set profile name. Useful
      // for auto-enrolment when someone new types IN. wweb.js stashes it
      // on `_data.notifyName`; fall back to the Contact resource if the
      // raw field isn't populated (some platforms omit it on groups).
      let authorName: string | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawNotify = (msg as any)._data?.notifyName;
      if (typeof rawNotify === "string" && rawNotify.trim()) {
        authorName = rawNotify.trim();
      } else {
        try {
          const contact = await msg.getContact();
          const pn = contact.pushname || contact.name;
          if (pn && pn.trim()) authorName = pn.trim();
        } catch {
          /* ignore — missing name just means server falls back to phone */
        }
      }

      // Record in the rolling history buffer so the smart analyser has
      // context for nuanced messages even when the fast-path short-
      // circuits.
      recordHistory(msg.from, {
        authorName: authorName ?? null,
        body: msg.body ?? "",
        timestamp: new Date((msg.timestamp ?? Date.now() / 1000) * 1000).toISOString(),
      });

      const outcome = await handleMessage({
        body: msg.body,
        from: msg.from,
        author: msg.author,
        authorName,
        waMessageId: msg.id?._serialized,
        reply: async (text: string) => {
          const chat = await client.getChatById(msg.from);
          await chat.sendMessage(text);
        },
        react: async (emoji: string) => {
          try {
            await msg.react(emoji);
          } catch (err) {
            console.error("Failed to react:", err);
          }
        },
      });

      // Fast-path didn't act → queue the message for the next batch
      // flush (every 10 min by default; immediate if kickoff < 1h or
      // buffer full).
      if (!outcome.handled) {
        try {
          await enqueueForAnalysis(client, msg);
        } catch (err) {
          console.error("enqueueForAnalysis failed:", err);
        }
      }
    },
  );

  // Reactions on any tracked message (bench-prompt 👍/👎). Forward to server
  // and let it decide the outcome.
  client.on("message_reaction", async (reaction) => {
    try {
      const waMessageId = reaction.msgId?._serialized;
      const fromId = reaction.senderId;
      const emoji = reaction.reaction;
      if (!waMessageId || !fromId || !emoji) return;
      const phone = fromId.replace("@c.us", "").replace(/^\+/, "");
      await postReaction({ waMessageId, emoji, fromPhone: phone });
    } catch (err) {
      console.error("Error forwarding reaction:", err);
    }
  });

  // Poll votes — forwarded to the server so MoM polls can merge with app
  // votes. The wweb.js event delivers a PollVote object with the voter
  // and the selected option names.
  client.on(
    "vote_update" as Parameters<typeof client.on>[0],
    async (vote: {
      parentMessage?: { id?: { _serialized?: string } };
      voter?: string;
      selectedOptions?: Array<{ name?: string; localId?: number }>;
    }) => {
      try {
        const waMessageId = vote.parentMessage?.id?._serialized;
        const voterId = vote.voter;
        if (!waMessageId || !voterId) return;
        const phone = voterId.replace("@c.us", "").replace(/^\+/, "");
        // selectedOptions can be empty (un-vote).
        const picked = vote.selectedOptions?.[0]?.name ?? null;
        await postPollVote({ waMessageId, voterPhone: phone, optionName: picked });
      } catch (err) {
        console.error("Error forwarding poll vote:", err);
      }
    },
  );

  // Group-membership events — someone joined or left a monitored group.
  // We forward the phone numbers (minus `@c.us`, minus any `@lid`
  // participants we can't resolve) to the server, which auto-onboards
  // new joiners and marks leavers as `leftAt` without destroying their
  // history. DMs to admins are queued server-side.
  //
  // Self-events (the bot itself being added/removed) are skipped so we
  // don't DM admins about the bot joining its own group.
  function extractPhones(recipientIds: string[] | undefined, selfId: string | undefined): string[] {
    if (!Array.isArray(recipientIds)) return [];
    return recipientIds
      .filter((id) => id.endsWith("@c.us"))
      .filter((id) => id !== selfId)
      .map((id) => id.replace("@c.us", "").replace(/^\+/, ""))
      .filter((p) => p.length > 0);
  }

  client.on(
    "group_join" as Parameters<typeof client.on>[0],
    async (notification: { chatId?: string; recipientIds?: string[] }) => {
      try {
        const groupId = notification.chatId;
        if (!groupId || !isMonitoredGroup(groupId)) return;
        const selfId = client.info?.wid?._serialized;
        const phones = extractPhones(notification.recipientIds, selfId);
        if (phones.length === 0) return;
        console.log(`group_join in ${groupId}: ${phones.join(", ")}`);
        await postGroupJoin({ groupId, phones });
      } catch (err) {
        console.error("Error forwarding group_join:", err);
      }
    },
  );

  client.on(
    "group_leave" as Parameters<typeof client.on>[0],
    async (notification: { chatId?: string; recipientIds?: string[] }) => {
      try {
        const groupId = notification.chatId;
        if (!groupId || !isMonitoredGroup(groupId)) return;
        const selfId = client.info?.wid?._serialized;
        const phones = extractPhones(notification.recipientIds, selfId);
        if (phones.length === 0) return;
        console.log(`group_leave in ${groupId}: ${phones.join(", ")}`);
        await postGroupLeave({ groupId, phones });
      } catch (err) {
        console.error("Error forwarding group_leave:", err);
      }
    },
  );

  client.on("disconnected", (reason: string) => {
    console.log("Client disconnected:", reason);
    stopScheduler();
    stopBatchFlushTimer();
  });

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    stopScheduler();
    stopBatchFlushTimer();
    await client.destroy();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    stopScheduler();
    stopBatchFlushTimer();
    await client.destroy();
    process.exit(0);
  });

  await client.initialize();
}

main().catch(console.error);
