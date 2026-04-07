import { config } from "./config.js";

const headers = {
  "Content-Type": "application/json",
  "x-api-key": config.apiKey,
};

export async function postAttendance(phoneNumber: string, action: "IN" | "OUT", groupId: string) {
  const res = await fetch(`${config.apiUrl}/api/whatsapp/attendance`, {
    method: "POST",
    headers,
    body: JSON.stringify({ phoneNumber, action, groupId }),
  });
  return res.json();
}

export async function getStatus(groupId: string) {
  const res = await fetch(`${config.apiUrl}/api/whatsapp/status?groupId=${groupId}`, {
    headers,
  });
  return res.json();
}

export async function getTeams(groupId: string) {
  const res = await fetch(`${config.apiUrl}/api/whatsapp/teams?groupId=${groupId}`, {
    headers,
  });
  return res.json();
}

export async function getEnabledOrgs() {
  const res = await fetch(`${config.apiUrl}/api/whatsapp/orgs`, {
    headers,
  });
  return res.json();
}
