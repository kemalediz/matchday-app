/**
 * THE ADMIN QUEUE'S GROUPING RULE — including the row that used to be
 * filtered out of existence.
 *
 * ── What changed on 2026-09-09 ───────────────────────────────────────
 *
 * `listUnresolved` and `unresolved-count` both queried
 * `AnalyzedMessage` with `authorUserId: null` AND `authorName: { not: null }`.
 * The 2026-08-30 independent audit:
 *
 *   "The admin unresolved queue excludes it by construction… A nameless
 *    unresolved message never appears in the badge or the queue."
 *
 * That is the worst possible filter to have on this particular surface.
 * The queue exists to show messages nobody could be attributed to; a
 * message with no name is the MOST unattributable kind there is, and it
 * was the one kind the queue could not show. Combined with the group
 * nudge being gated on the same field, a degraded @lid sender's IN
 * vanished with no trace anywhere a human looks.
 *
 * The filter is gone. Nameless rows now collapse into a single, clearly
 * labelled "Unknown sender" bucket.
 *
 * ── Why one bucket, and why it is not linkable ───────────────────────
 *
 * One bucket because twelve unattributable messages are ONE problem, not
 * twelve: a badge reading 12 is noise an admin learns to ignore, and the
 * queue's whole value is that its number is small enough to act on.
 *
 * Not linkable because the "link to player" action creates a `UserAlias`
 * keyed on the pushname, and there is no pushname. Offering the control
 * would be offering something that cannot work — and, worse, would put a
 * junk alias in the table that then matches nobody forever. Seeing the
 * messages is still the point: it tells the admin the bot is failing to
 * identify people, which is the fault to chase.
 */

/** The key every nameless message shares. Never a real pushname. */
export const UNKNOWN_SENDER_KEY = "__unknown_sender__";

/** What the admin sees instead of an empty pair of quote marks. */
export const UNKNOWN_SENDER_LABEL = "Unknown sender";

const norm = (s: string) =>
  s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** The grouping key for one row's author name. */
export function unresolvedKey(authorName: string | null): string {
  const name = (authorName ?? "").trim();
  if (name.length === 0) return UNKNOWN_SENDER_KEY;
  const key = norm(name);
  return key.length === 0 ? UNKNOWN_SENDER_KEY : key;
}

export interface UnresolvedRow {
  authorName: string | null;
  intent: string | null;
  body: string | null;
  createdAt: Date;
}

export interface UnresolvedGroup {
  /** Normalised pushname key (what an alias would store), or the
   *  unknown-sender bucket. */
  key: string;
  /** Display pushname (most recent raw form), or the unknown label. */
  pushname: string;
  count: number;
  /** Most recent attendance-relevant intent seen for this pushname. */
  lastIntent: string;
  lastBody: string;
  lastAt: string;
  sampleBodies: string[];
  /**
   * May an admin link this row to a player?
   *
   * False for the unknown-sender bucket: linking writes a `UserAlias`
   * keyed on the pushname, and there is none.
   */
  linkable: boolean;
}

const MAX_SAMPLES = 4;
const MAX_BODY_CHARS = 160;

/**
 * Group unresolved attendance messages by sender, newest first.
 *
 * Rows must already be filtered (org, attendance-relevant intent, recent)
 * and sorted newest-first by the caller — the first row seen for a key is
 * the one whose raw spelling and intent are shown.
 */
export function groupUnresolved(rows: UnresolvedRow[]): UnresolvedGroup[] {
  const byKey = new Map<string, UnresolvedGroup>();
  for (const r of rows) {
    const key = unresolvedKey(r.authorName);
    const body = (r.body ?? "").slice(0, MAX_BODY_CHARS);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        key,
        pushname:
          key === UNKNOWN_SENDER_KEY ? UNKNOWN_SENDER_LABEL : (r.authorName ?? "").trim(),
        count: 1,
        lastIntent: r.intent ?? "?",
        lastBody: body,
        lastAt: r.createdAt.toISOString(),
        sampleBodies: [body],
        linkable: key !== UNKNOWN_SENDER_KEY,
      });
      continue;
    }
    existing.count += 1;
    if (existing.sampleBodies.length < MAX_SAMPLES) existing.sampleBodies.push(body);
    // Rows arrive newest-first, but do not trust it: a caller that changes
    // its `orderBy` must not silently start showing the oldest message as
    // "last".
    if (r.createdAt.toISOString() > existing.lastAt) {
      existing.lastAt = r.createdAt.toISOString();
      existing.lastIntent = r.intent ?? "?";
      existing.lastBody = body;
    }
  }
  return [...byKey.values()].sort(
    (a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime(),
  );
}
