/**
 * Light-touch E.164 normalisation for WhatsApp bot matching.
 *
 * - Strips whitespace, dashes, parens.
 * - "00…" → "+…".
 * - UK mobile "07xxxxxxxxx" → "+44…".
 * - Leaves anything else untouched (admin is responsible for valid input).
 *
 * Keeping this deliberately conservative: we only transform formats we're
 * confident about. Unknown shapes round-trip unchanged so we never silently
 * corrupt a number.
 */
export function normalisePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let s = trimmed.replace(/[\s\-()]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  else if (/^07\d{9}$/.test(s)) s = "+44" + s.slice(1);
  return s;
}
