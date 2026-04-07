import { postAttendance } from "./api.js";
import { attendanceResponse, unknownPlayerMessage, errorMessage } from "./messages.js";

const IN_PATTERN = /^(in|i'm in|im in|i am in|yes|playing|count me in)$/i;
const OUT_PATTERN = /^(out|i'm out|im out|i am out|can't make it|cant make it|not playing|drop|no)$/i;

interface Message {
  body: string;
  from: string;           // group JID: xxx@g.us
  author?: string;        // sender in group: 447xxx@c.us
  reply: (text: string) => Promise<void>;
}

// Set of group JIDs we're monitoring
let monitoredGroups = new Set<string>();

export function setMonitoredGroups(groupIds: string[]) {
  monitoredGroups = new Set(groupIds);
}

export async function handleMessage(msg: Message) {
  // Only process messages from monitored groups
  if (!msg.from.endsWith("@g.us")) return;
  if (!monitoredGroups.has(msg.from)) return;

  const text = msg.body.trim();
  const isIn = IN_PATTERN.test(text);
  const isOut = OUT_PATTERN.test(text);

  if (!isIn && !isOut) return;

  // Extract phone number from author (format: 447xxx@c.us)
  const authorId = msg.author || msg.from;
  const phone = "+" + authorId.replace("@c.us", "");

  try {
    const action = isIn ? "IN" : "OUT";
    const result = await postAttendance(phone, action, msg.from);

    if (result.error === "unknown_player") {
      await msg.reply(unknownPlayerMessage(phone));
      return;
    }

    if (result.error) {
      await msg.reply(result.message || result.error);
      return;
    }

    await msg.reply(
      attendanceResponse(result.player, action, result.status, result.confirmed, result.max)
    );
  } catch (err) {
    console.error("Error handling message:", err);
    await msg.reply(errorMessage());
  }
}
