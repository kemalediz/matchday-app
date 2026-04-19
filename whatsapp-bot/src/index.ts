import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode-terminal";
import { handleMessage, setMonitoredGroups } from "./handlers.js";
import { initScheduler, stopScheduler } from "./scheduler.js";
import { getEnabledOrgs, postReaction } from "./api.js";
import { config } from "./config.js";

async function main() {
  console.log("MatchDay WhatsApp Bot starting...");
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

      initScheduler(client, orgConfigs);
    } catch (err) {
      console.error("Failed to fetch org configs:", err);
    }
  });

  // Inbound group messages — IN/OUT detection.
  client.on(
    "message",
    async (msg) => {
      await handleMessage({
        body: msg.body,
        from: msg.from,
        author: msg.author,
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

  client.on("disconnected", (reason: string) => {
    console.log("Client disconnected:", reason);
    stopScheduler();
  });

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    stopScheduler();
    await client.destroy();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    stopScheduler();
    await client.destroy();
    process.exit(0);
  });

  await client.initialize();
}

main().catch(console.error);
