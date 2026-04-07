import { getStatus, getTeams } from "./api.js";
import { statusMessage, teamsMessage } from "./messages.js";
import { config } from "./config.js";

interface WhatsAppClient {
  sendMessage: (chatId: string, text: string) => Promise<void>;
}

interface OrgConfig {
  groupId: string;
  orgName: string;
  lastTeamAnnouncement?: string;
}

let client: WhatsAppClient | null = null;
let orgs: OrgConfig[] = [];
let intervalId: ReturnType<typeof setInterval> | null = null;

export function initScheduler(waClient: WhatsAppClient, orgConfigs: OrgConfig[]) {
  client = waClient;
  orgs = orgConfigs;

  const intervalMs = config.statusIntervalHours * 60 * 60 * 1000;
  intervalId = setInterval(postUpdates, intervalMs);

  console.log(`Scheduler started: posting updates every ${config.statusIntervalHours}h for ${orgs.length} org(s)`);
}

export function stopScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

async function postUpdates() {
  if (!client) return;

  for (const org of orgs) {
    try {
      // Post attendance status
      const statusData = await getStatus(org.groupId);
      if (statusData.match) {
        const msg = statusMessage(statusData.match);
        await client.sendMessage(org.groupId, msg);
        console.log(`Posted status to ${org.orgName}: ${statusData.match.confirmed}/${statusData.match.max}`);

        // Check for new team announcements
        if (statusData.match.status === "TEAMS_PUBLISHED") {
          const teamsData = await getTeams(org.groupId);
          if (teamsData.teams && teamsData.match.name !== org.lastTeamAnnouncement) {
            const teamMsg = teamsMessage(teamsData.match.name, teamsData.teams.red, teamsData.teams.yellow);
            await client.sendMessage(org.groupId, teamMsg);
            org.lastTeamAnnouncement = teamsData.match.name;
            console.log(`Posted team announcement to ${org.orgName}`);
          }
        }
      }
    } catch (err) {
      console.error(`Failed to post update for ${org.orgName}:`, err);
    }
  }
}
