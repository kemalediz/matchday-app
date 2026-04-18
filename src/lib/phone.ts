/**
 * Normalise a user-entered phone number to strict E.164 (`+` + digits).
 *
 * - Strips whitespace, dashes, parens.
 * - Strips bidirectional-formatting control characters (U+200E, U+200F,
 *   U+202A–U+202E) that sneak in when copying from WhatsApp / iOS
 *   contacts. These are invisible but break equality comparisons.
 * - "00…" → "+…".
 * - UK mobile "07xxxxxxxxx" → "+44…".
 * - Final pass: anything that isn't `+` or a digit is stripped, and `+`
 *   only survives if it's in position 0.
 *
 * Returns null for empty input.
 */
export function normalisePhone(raw: string): string | null {
  if (!raw) return null;
  // Strip bidi marks + all whitespace first.
  let s = raw.replace(/[\u200E\u200F\u202A-\u202E\s\-()]/g, "").trim();
  if (!s) return null;
  if (s.startsWith("00")) s = "+" + s.slice(2);
  else if (/^07\d{9}$/.test(s)) s = "+44" + s.slice(1);
  // Final pass: keep only digits and a single leading +.
  const plus = s.startsWith("+");
  const digits = s.replace(/\D/g, "");
  if (!digits) return null;
  return (plus ? "+" : "") + digits;
}
