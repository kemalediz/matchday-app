/**
 * Parses a WhatsApp chat export (.txt) into structured data for the
 * onboarding wizard.
 *
 * Supports both iOS and Android export formats:
 *   iOS:     [22/04/2026, 21:30:00] Kemal Ediz: Hey all
 *   Android: 22/04/2026, 21:30 - Kemal Ediz: Hey all
 *
 * Continuation lines (multi-line messages) are appended to the previous
 * message. System lines ("... created group", "... added", encryption
 * notice) are flagged and excluded from the player list.
 *
 * Output is deliberately minimal — downstream wizard steps pick what
 * they need (group name, unique authors, date range, last N messages
 * for LLM analysis).
 */

export interface ParsedMessage {
  /** When the message was sent (best-effort; timezone-naive in group-local time). */
  timestamp: Date;
  /** Author display name as shown in the export. Null for system lines. */
  author: string | null;
  /** Message body — may include newlines for multi-line messages. */
  body: string;
  /** True for "X created group", "X added Y", end-to-end encryption notice. */
  system: boolean;
}

export interface ParsedAuthor {
  /** Name as it appears in the export. */
  name: string;
  /** Phone number if the author was saved as a contact but exported by phone. */
  phone: string | null;
  /** Total messages authored by this person. */
  messageCount: number;
  /** First message timestamp for this author. */
  firstSeen: Date;
  /** Most recent message timestamp. */
  lastSeen: Date;
}

export interface ParsedChat {
  groupName: string | null;
  firstMessageAt: Date | null;
  lastMessageAt: Date | null;
  totalMessages: number;
  systemMessageCount: number;
  authors: ParsedAuthor[];
  /** Most recent N messages, body-only, for downstream LLM analysis. */
  recentMessages: ParsedMessage[];
}

// Match the line-start timestamp in both formats. Capture groups:
//   1: DD/MM/YYYY or MM/DD/YYYY (we treat as DD/MM/YYYY — UK default)
//   2: HH:MM or HH:MM:SS
//   3: author (null for system lines — detected separately)
//   4: body
//
// iOS wraps in [ ] with comma+space inside; Android uses " - " separator.
const IOS_LINE = /^\[(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:AM|PM|am|pm)?\]\s*(?:([^:]+?):\s)?(.*)$/;
const ANDROID_LINE = /^(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:AM|PM|am|pm)?\s*-\s*(?:([^:]+?):\s)?(.*)$/;

/** Parse a date string from the export. Defaults to UK format (DD/MM/YYYY). */
function parseDate(dateStr: string, timeStr: string): Date {
  const parts = dateStr.split(/[/.\-]/);
  if (parts.length !== 3) return new Date(NaN);
  let [d, m, y] = parts;
  if (y.length === 2) y = `20${y}`;
  const [hh, mm, ss = "00"] = timeStr.split(":");
  const iso = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T${hh.padStart(2, "0")}:${mm.padStart(2, "0")}:${ss.padStart(2, "0")}`;
  const dt = new Date(iso);
  return isNaN(dt.getTime()) ? new Date(NaN) : dt;
}

/** Strip the hidden LRM / LRE / RLE / PDF control chars WhatsApp injects. */
function cleanControlChars(s: string): string {
  return s.replace(/[\u200E\u200F\u202A-\u202E]/g, "").trim();
}

/** Detect obvious system-event lines that should not become players. */
function isSystemLine(body: string): boolean {
  const b = body.toLowerCase();
  return (
    b.includes("messages and calls are end-to-end encrypted") ||
    b.includes("created group") ||
    b.includes("added ") ||
    b.includes("removed ") ||
    b.includes("left") ||
    b.includes("changed the group") ||
    b.includes("changed this group") ||
    b.includes("changed the subject") ||
    b.includes("changed their phone number") ||
    b.includes("security code") ||
    b.includes("this message was deleted") ||
    b.includes("<media omitted>") ||
    b.includes("null")
  );
}

/** Heuristic: pull the group name from a "created group \"Foo\"" line, if present. */
function extractGroupName(lines: string[]): string | null {
  for (const raw of lines.slice(0, 25)) {
    const line = cleanControlChars(raw);
    const m =
      line.match(/created group ["“”](.+?)["“”]/i) ??
      line.match(/changed the subject (?:from .+ )?to ["“”](.+?)["“”]/i);
    if (m) return m[1];
  }
  return null;
}

/** Peel "+44 7123 456789" style phones out of author fields if present. */
function extractPhoneFromAuthor(author: string): { name: string; phone: string | null } {
  const phoneMatch = author.match(/(\+?\d[\d\s\-()]{6,})/);
  if (phoneMatch) {
    const phone = phoneMatch[1].replace(/[^\d+]/g, "");
    const name = author.replace(phoneMatch[0], "").replace(/^~\s*/, "").trim();
    return { name: name || phone, phone };
  }
  // Drop the leading "~" that WhatsApp uses for unsaved contacts.
  return { name: author.replace(/^~\s*/, "").trim(), phone: null };
}

export function parseWhatsAppChat(text: string, opts: { recentMessageLimit?: number } = {}): ParsedChat {
  const recentLimit = opts.recentMessageLimit ?? 400;
  const rawLines = text.split(/\r?\n/);
  const messages: ParsedMessage[] = [];

  let current: ParsedMessage | null = null;

  for (const rawLine of rawLines) {
    const line = cleanControlChars(rawLine);
    if (!line) continue;

    const match = line.match(IOS_LINE) ?? line.match(ANDROID_LINE);
    if (!match) {
      // Continuation — append to the previous message.
      if (current) current.body += `\n${line}`;
      continue;
    }
    const [, dateStr, timeStr, author, body] = match;
    const ts = parseDate(dateStr, timeStr);
    if (isNaN(ts.getTime())) continue;

    const cleanedBody = cleanControlChars(body ?? "");
    const system = author == null || isSystemLine(cleanedBody);
    current = {
      timestamp: ts,
      author: author ? cleanControlChars(author) : null,
      body: cleanedBody,
      system,
    };
    messages.push(current);
  }

  const nonSystem = messages.filter((m) => !m.system && m.author);
  const systemMessageCount = messages.length - nonSystem.length;

  // Aggregate authors. Key by (name, phone) so two players with the
  // same display name but different numbers stay separate. Within a
  // name, a row without a phone merges into any existing same-name row
  // that does have one (WhatsApp occasionally shows the bare name for
  // one message and the ~name + phone format for the next).
  const byAuthor = new Map<string, ParsedAuthor>();
  for (const m of nonSystem) {
    const { name, phone } = extractPhoneFromAuthor(m.author!);
    if (!name) continue;
    const nameKey = name.toLowerCase();
    const key = phone ? `${nameKey}|${phone}` : nameKey;

    // Case 1: exact (name, phone) key exists.
    const exact = byAuthor.get(key);
    if (exact) {
      exact.messageCount += 1;
      if (m.timestamp < exact.firstSeen) exact.firstSeen = m.timestamp;
      if (m.timestamp > exact.lastSeen) exact.lastSeen = m.timestamp;
      continue;
    }

    // Case 2: no phone on this row — merge into existing same-name row
    // that has a phone (ambiguous fallback is fine when there's exactly
    // one phone-bearing row for this name).
    if (!phone) {
      const candidates = [...byAuthor.values()].filter(
        (a) => a.name.toLowerCase() === nameKey,
      );
      if (candidates.length === 1) {
        const c = candidates[0];
        c.messageCount += 1;
        if (m.timestamp < c.firstSeen) c.firstSeen = m.timestamp;
        if (m.timestamp > c.lastSeen) c.lastSeen = m.timestamp;
        continue;
      }
    }

    // Case 3: brand-new (name, phone) row.
    byAuthor.set(key, {
      name,
      phone,
      messageCount: 1,
      firstSeen: m.timestamp,
      lastSeen: m.timestamp,
    });
  }
  const authors = Array.from(byAuthor.values()).sort(
    (a, b) => b.messageCount - a.messageCount,
  );

  const firstMessageAt =
    nonSystem.length > 0 ? nonSystem[0].timestamp : null;
  const lastMessageAt =
    nonSystem.length > 0 ? nonSystem[nonSystem.length - 1].timestamp : null;

  const recentMessages = nonSystem.slice(-recentLimit);

  return {
    groupName: extractGroupName(rawLines),
    firstMessageAt,
    lastMessageAt,
    totalMessages: nonSystem.length,
    systemMessageCount,
    authors,
    recentMessages,
  };
}
