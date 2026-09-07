/**
 * NAME FOLDING — pure, and deliberately on its own.
 *
 * Lifted out of `squad-from-list.ts` on 2026-09-07, unchanged. That file
 * imports Prisma and the Anthropic SDK; this function imports nothing.
 * Every module that only wanted to fold a name was dragging a database
 * client behind it, and one of them — `pasted-roster.ts` — is imported
 * by `pipeline/run.ts`, which the Playwright corpus harness loads
 * IN-PROCESS ("no Prisma in the Playwright process", `e2e/sim/group.ts`).
 * That is a hard failure, not a preference: the generated client is CJS
 * and the harness is ESM, so it dies with "exports is not defined in ES
 * module scope" before a single test runs.
 *
 * `squad-from-list.ts` re-exports it, so every existing import keeps
 * working and there is exactly one implementation. Do not add a second
 * copy of these rules anywhere: `pasted-roster.ts`'s `sameName` and
 * `rosterMentions` compare against what this returns, and a folding
 * rule that drifts between two files is a name that matches in one
 * place and not the other.
 */

/** Normalise a name for diffing / alias storage:
 *   - NFD + drop combining diacritics
 *   - lowercase
 *   - drop zero-width / word-joiner / non-breaking space (whatsapp
 *     copy-paste emits U+2060 / U+00A0 / U+200B liberally)
 *   - collapse whitespace
 *   - strip leading "~" (whatsapp prefixes pushnames of unsaved contacts) */
export function normaliseName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u00a0\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, " ")
    .replace(/^~+\s*/, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}
