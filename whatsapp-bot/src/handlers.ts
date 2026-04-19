import { postAttendance } from "./api.js";
import { unknownPlayerMessage, errorMessage } from "./messages.js";

/**
 * IN/OUT detection — wider than a strict exact-match so real chat messages
 * get picked up.
 *
 * "in", "IN", "i'm in", "im in", "I am in", "count me in", "I will play",
 * "yes", "👍", "✅", "✔️", "IN 👍", "in guys", "In mate!"
 * are all treated as IN.
 *
 * Counter: "out", "OUT", "i'm out", "im out", "can't make it",
 * "cant make it", "not playing", "drop", "count me out", "no", "👎", "❌"
 * are OUT.
 *
 * To avoid false positives from substring matches (e.g. "joined",
 * "invited", "going IN on Arsenal"), the extract() function requires:
 *   - Word-boundary matches for English words
 *   - The whole message is ≤40 chars OR starts with the keyword
 * Anything more nuanced → return null → bot stays quiet.
 */
const IN_WORDS = [
  /\bin\b/i,
  /\bi[' ]?m in\b/i,
  /\bi am in\b/i,
  /\bcount me in\b/i,
  /\bi will play\b/i,
  /\bi'?ll play\b/i,
  /\bplaying\b/i,
  /\byes\b/i,
];
const OUT_WORDS = [
  /\bout\b/i,
  /\bi[' ]?m out\b/i,
  /\bi am out\b/i,
  /\bcan[' ]?t make it\b/i,
  /\bnot playing\b/i,
  /\bcount me out\b/i,
  /\bdrop\b/i,
  /\bno\b/i,
];
const IN_EMOJIS = ["👍", "✅", "✔️", "🙋‍♂️", "🙋‍♀️", "🙋"];
const OUT_EMOJIS = ["👎", "❌", "🚫"];

function hasEmoji(text: string, set: string[]): boolean {
  return set.some((e) => text.includes(e));
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

export function extract(text: string): "IN" | "OUT" | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const inEmoji = hasEmoji(trimmed, IN_EMOJIS);
  const outEmoji = hasEmoji(trimmed, OUT_EMOJIS);
  const inWord = matchesAny(trimmed, IN_WORDS);
  const outWord = matchesAny(trimmed, OUT_WORDS);

  const isIn = inEmoji || inWord;
  const isOut = outEmoji || outWord;

  if (isIn && isOut) return null; // ambiguous — don't guess
  if (isIn) return "IN";
  if (isOut) return "OUT";
  return null;
}

interface Message {
  body: string;
  from: string;           // group JID: xxx@g.us
  author?: string;        // participant in group: 447xxx@c.us
  reply: (text: string) => Promise<void>;
  react?: (emoji: string) => Promise<void>;
}

let monitoredGroups = new Set<string>();

export function setMonitoredGroups(groupIds: string[]) {
  monitoredGroups = new Set(groupIds);
}

export async function handleMessage(msg: Message) {
  if (!msg.from.endsWith("@g.us")) return;
  if (!monitoredGroups.has(msg.from)) return;

  const action = extract(msg.body);
  if (!action) return;

  const authorId = msg.author || msg.from;
  const phone = "+" + authorId.replace("@c.us", "");

  try {
    const result = await postAttendance(phone, action, msg.from);

    if (result.error === "unknown_player") {
      await msg.reply(unknownPlayerMessage(phone));
      return;
    }

    if (result.error) {
      await msg.reply(result.message || result.error);
      return;
    }

    // Silent success — just react with 👍 instead of replying. Keeps the
    // group chat quiet. The user sees the reaction on their own message.
    if (msg.react) {
      await msg.react(action === "IN" ? "👍" : "👋");
    }
  } catch (err) {
    console.error("Error handling message:", err);
    await msg.reply(errorMessage());
  }
}
