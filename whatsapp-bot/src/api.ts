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

export async function postScore(params: {
  fromPhone: string;
  redScore: number;
  yellowScore: number;
  groupId: string;
}) {
  const res = await fetch(`${config.apiUrl}/api/whatsapp/score`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });
  return res.json();
}

export async function getEnabledOrgs() {
  const res = await fetch(`${config.apiUrl}/api/whatsapp/orgs`, { headers });
  return res.json();
}

// ─────────────────── Scheduler endpoints (new) ───────────────────────

export type DueInstruction =
  | { kind: "group-message"; key: string; text: string; matchId?: string }
  | {
      kind: "group-poll";
      key: string;
      question: string;
      options: string[];
      multi?: boolean;
      matchId?: string;
    }
  | {
      kind: "dm";
      key: string;
      phone: string;
      text: string;
      matchId?: string;
      targetUser?: string;
    }
  | {
      kind: "bench-prompt";
      key: string;
      phone: string;
      text: string;
      matchId: string;
      userId: string;
    };

export async function getDuePosts(groupId: string): Promise<{
  instructions: DueInstruction[];
  waGroupId: string;
  orgId: string;
} | null> {
  const res = await fetch(
    `${config.apiUrl}/api/whatsapp/due-posts?groupId=${encodeURIComponent(groupId)}`,
    { headers },
  );
  if (!res.ok) {
    const body = await res.text();
    console.error("due-posts request failed:", res.status, body);
    return null;
  }
  return res.json();
}

export async function ackInstruction(ack: {
  key: string;
  kind: string;
  matchId?: string;
  targetUser?: string;
  waMessageId?: string;
  benchUserId?: string;
}): Promise<void> {
  const res = await fetch(`${config.apiUrl}/api/whatsapp/ack`, {
    method: "POST",
    headers,
    body: JSON.stringify(ack),
  });
  if (!res.ok) {
    console.error("ack failed:", res.status, await res.text());
  }
}

export async function postReaction(params: {
  waMessageId: string;
  emoji: string;
  fromPhone: string;
}): Promise<void> {
  const res = await fetch(`${config.apiUrl}/api/whatsapp/reaction`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    console.error("reaction post failed:", res.status, await res.text());
  }
}

export async function postPollVote(params: {
  waMessageId: string;
  voterPhone: string;
  optionName: string | null;
}): Promise<void> {
  const res = await fetch(`${config.apiUrl}/api/whatsapp/poll-vote`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    console.error("poll-vote post failed:", res.status, await res.text());
  }
}

export async function postGroupJoin(params: {
  groupId: string;
  phones: string[]; // E.164 without the leading "+"
}): Promise<void> {
  const res = await fetch(`${config.apiUrl}/api/whatsapp/group-join`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    console.error("group-join post failed:", res.status, await res.text());
  }
}

export async function postGroupLeave(params: {
  groupId: string;
  phones: string[];
}): Promise<void> {
  const res = await fetch(`${config.apiUrl}/api/whatsapp/group-leave`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    console.error("group-leave post failed:", res.status, await res.text());
  }
}
