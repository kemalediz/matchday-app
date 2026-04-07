import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode-terminal";
import { handleMessage, setMonitoredGroups } from "./handlers.js";
import { initScheduler, stopScheduler } from "./scheduler.js";
import { getEnabledOrgs } from "./api.js";
import { config } from "./config.js";

async function main() {
  console.log("MatchDay WhatsApp Bot starting...");
  console.log(`API URL: ${config.apiUrl}`);

  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });

  client.on("qr", (qr: string) => {
    console.log("\nScan this QR code with WhatsApp on the burner phone:\n");
    qrcode.generate(qr, { small: true });
  });

  client.on("ready", async () => {
    console.log("\nWhatsApp bot is ready!");

    // Fetch enabled orgs from MatchDay API
    try {
      const data = await getEnabledOrgs();
      const orgConfigs = (data.orgs || [])
        .filter((o: { whatsappGroupId: string | null }) => o.whatsappGroupId)
        .map((o: { whatsappGroupId: string; name: string }) => ({
          groupId: o.whatsappGroupId,
          orgName: o.name,
        }));

      const groupIds = orgConfigs.map((o: { groupId: string }) => o.groupId);
      setMonitoredGroups(groupIds);

      console.log(`Monitoring ${orgConfigs.length} group(s):`);
      orgConfigs.forEach((o: { orgName: string; groupId: string }) => {
        console.log(`  - ${o.orgName} (${o.groupId})`);
      });

      // Start periodic status updates
      initScheduler(client, orgConfigs);
    } catch (err) {
      console.error("Failed to fetch org configs:", err);
      console.log("Bot will listen to all groups but won't post updates.");
    }
  });

  client.on("message", async (msg: { body: string; from: string; author?: string }) => {
    await handleMessage({
      body: msg.body,
      from: msg.from,
      author: msg.author,
      reply: async (text: string) => {
        const chat = await (client as typeof pkg.Client.prototype).getChatById(msg.from);
        await chat.sendMessage(text);
      },
    });
  });

  client.on("disconnected", (reason: string) => {
    console.log("Client disconnected:", reason);
    stopScheduler();
  });

  // Graceful shutdown
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
