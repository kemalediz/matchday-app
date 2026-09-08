/**
 * Corpus loader + validator.
 *
 * The corpus is stored as JSONL — one case per line — because that is
 * what the redesign doc asked for and because it is the right shape for
 * this artefact: adding a case is a one-line diff, the file is readable
 * by anything (a future non-TypeScript runner included), and `grep S8`
 * finds every case for a prompt section without a parser.
 *
 * Everything here is pure and filesystem-only; no DB, no model.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ALL_CORPUS_ROUTES,
  ALL_PROMPT_SECTIONS,
  type AttStatus,
  type Category,
  type CorpusCase,
  type CorpusMessage,
} from "./grade";

// NOT import.meta.url: this file is loaded in both CJS (Playwright's
// transpile) and ESM (vitest) contexts, exactly like e2e/helpers/env.ts,
// which documents the same trap. Every entry point runs from the repo
// root and env.ts asserts it.
export const CORPUS_PATH = path.join(process.cwd(), "e2e", "corpus", "incidents.jsonl");

const CATEGORIES: Category[] = ["A", "B", "C", "D", "E"];
const STATUSES: string[] = ["CONFIRMED", "BENCH", "DROPPED", "ABSENT"];

class CorpusError extends Error {}

function bad(where: string, msg: string): never {
  throw new CorpusError(`corpus: ${where}: ${msg}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse + validate a JSONL corpus body. Throws on the first problem. */
export function parseCorpus(body: string): CorpusCase[] {
  const cases: CorpusCase[] = [];
  const seen = new Set<string>();
  const lines = body.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("#")) continue;
    const where = `line ${i + 1}`;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      bad(where, `not valid JSON — ${(err as Error).message}`);
    }
    if (!isRecord(parsed)) bad(where, "each line must be a JSON object");

    const id = parsed.id;
    if (typeof id !== "string" || !id.trim()) bad(where, "missing a non-empty `id`");
    if (seen.has(id)) bad(where, `duplicate case id "${id}"`);
    seen.add(id);

    const at = `${where} (${id})`;
    if (typeof parsed.title !== "string" || !parsed.title.trim()) {
      bad(at, "missing a non-empty `title`");
    }

    const sections = parsed.sections;
    if (!Array.isArray(sections) || sections.length === 0) {
      bad(at, "must cite at least one §3.2 section id in `sections`");
    }
    for (const s of sections) {
      if (typeof s !== "string" || !ALL_PROMPT_SECTIONS.includes(s)) {
        bad(at, `unknown §3.2 section id ${JSON.stringify(s)} (expected S0–S38)`);
      }
    }

    if (typeof parsed.category !== "string" || !CATEGORIES.includes(parsed.category as Category)) {
      bad(at, `unknown \`category\` ${JSON.stringify(parsed.category)} (expected A–E)`);
    }

    const prov = parsed.provenance;
    if (!isRecord(prov) || typeof prov.note !== "string" || !prov.note.trim()) {
      bad(at, "missing `provenance` — every case must say where its ground truth came from");
    }
    if (!["commit", "pr", "doc"].includes(String(prov.kind))) {
      bad(at, `provenance.kind must be commit | pr | doc, got ${JSON.stringify(prov.kind)}`);
    }
    if (prov.kind !== "doc" && (typeof prov.ref !== "string" || !prov.ref.trim())) {
      bad(at, "a commit- or PR-sourced case must name its `provenance.ref`");
    }

    const world = parsed.world;
    if (!isRecord(world) || !Array.isArray(world.players) || world.players.length === 0) {
      bad(at, "`world.players` must list the roster the messages land in");
    }
    const keys = new Set<string>();
    const names: string[] = [];
    for (const p of world.players as unknown[]) {
      if (!isRecord(p) || typeof p.key !== "string" || typeof p.name !== "string") {
        bad(at, "every world.players entry needs a `key` and a `name`");
      }
      if (keys.has(p.key)) bad(at, `duplicate player key "${p.key}"`);
      keys.add(p.key);
      names.push(p.name);
    }
    const seededKeys = new Set<string>();
    for (const a of (world.attendance ?? []) as unknown[]) {
      if (!isRecord(a) || typeof a.key !== "string" || !keys.has(a.key)) {
        bad(at, `world.attendance references unknown player key ${JSON.stringify(isRecord(a) ? a.key : a)}`);
      }
      // One player, one row. A duplicate is a Postgres primary-key
      // violation that only surfaces mid-run, and by then it has taken
      // down every case after it.
      if (seededKeys.has(a.key)) {
        bad(at, `world.attendance seeds "${a.key}" twice — one player has one attendance row`);
      }
      seededKeys.add(a.key);
      if (!["CONFIRMED", "BENCH", "DROPPED"].includes(String(a.status))) {
        bad(at, `world.attendance has an unknown status ${JSON.stringify(a.status)}`);
      }
    }
    if (world.openBenchSlotByDropping !== undefined && !keys.has(String(world.openBenchSlotByDropping))) {
      bad(at, `world.openBenchSlotByDropping references unknown key "${world.openBenchSlotByDropping}"`);
    }

    const messages = parsed.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      bad(at, "`messages` must carry at least one inbound message");
    }
    let anyStub = false;
    for (const m of messages as unknown[]) {
      if (!isRecord(m) || typeof m.body !== "string") bad(at, "every message needs a `body`");
      if (typeof m.from === "string") {
        if (!keys.has(m.from)) bad(at, `message from unknown roster key "${m.from}"`);
      } else if (isRecord(m.from)) {
        if (typeof m.from.phone !== "string") bad(at, "an outsider `from` needs a `phone`");
      } else {
        bad(at, "`from` must be a roster key or an { name, phone } outsider");
      }
      // The dead seam, named so a case ported carelessly from the old
      // format says what is wrong with it instead of running as a
      // live-only case that quietly stopped covering anything.
      if (m.stub !== undefined) {
        bad(
          at,
          "`stub` is the deleted VERDICT seam (§10 step 8). A message says what the ROUTER " +
            "answered (`route`) and what the EXTRACTOR found (`facts`) — never what to do",
        );
      }
      if (m.route !== undefined) {
        if (typeof m.route !== "string" || !ALL_CORPUS_ROUTES.includes(m.route)) {
          bad(at, `unknown \`route\` ${JSON.stringify(m.route)} (expected one of ${ALL_CORPUS_ROUTES.join(", ")})`);
        }
        anyStub = true;
      }
      if (m.facts !== undefined) {
        if (!isRecord(m.facts)) bad(at, "`facts` must be an object — the extractor's raw JSON");
        if (m.route === undefined) {
          bad(at, "`facts` without a `route`: nothing decides which extractor they belong to");
        }
      }
    }
    if (anyStub && parsed.stubKind !== "transcribed") {
      bad(
        at,
        "a case carrying routes must declare `stubKind: \"transcribed\"` — every stubbed field " +
          "is a property of the message text, checkable by re-reading it. The old values " +
          '"historical" and "corrected" described VERDICTS and went with them',
      );
    }
    if (!anyStub && parsed.stubKind !== undefined) {
      bad(at, "`stubKind` set but no message carries a `route`");
    }
    // A case with no route never runs in CI. "61 cases" must not be
    // allowed to imply "61 cases in CI", so every exemption is argued
    // case by case rather than left as a silent default.
    if (!anyStub && (typeof parsed.liveOnlyReason !== "string" || !parsed.liveOnlyReason.trim())) {
      bad(
        at,
        "carries no `route`, so it can never run in CI — set `liveOnlyReason` explaining " +
          "what a stub would destroy (usually: the assertion IS the model's classification, the " +
          "READING of the message was itself the incident, or the asserted text is model-authored)",
      );
    }
    if (anyStub && parsed.liveOnlyReason !== undefined) {
      bad(at, "`liveOnlyReason` set on a case that DOES carry routes");
    }

    // Every CHANGED expectation carries its reason at the case.
    if (parsed.adjudication !== undefined) {
      const a = parsed.adjudication;
      if (!isRecord(a)) bad(at, "`adjudication` must be an object");
      if (!["old_right", "new_right", "harness"].includes(String(a.verdict))) {
        bad(at, `adjudication.verdict must be old_right | new_right | harness, got ${JSON.stringify(a.verdict)}`);
      }
      if (typeof a.reason !== "string" || a.reason.trim().length < 20) {
        bad(at, "`adjudication.reason` must be a sentence a human can check, not a label");
      }
      if (typeof a.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(a.date)) {
        bad(at, "`adjudication.date` must be an ISO date (YYYY-MM-DD)");
      }
    }

    const exp = parsed.expect;
    if (!isRecord(exp)) bad(at, "missing `expect`");
    const asserts =
      exp.attendance !== undefined ||
      exp.unchanged !== undefined ||
      exp.counts !== undefined ||
      exp.benchOffersOpen !== undefined ||
      exp.score !== undefined ||
      exp.speaks !== undefined ||
      exp.speaksAtMost !== undefined ||
      exp.teamsUnchanged !== undefined ||
      exp.claimsMatchWrites === true ||
      exp.react !== undefined ||
      exp.mustMention !== undefined ||
      exp.mustNotMention !== undefined ||
      exp.mustMatch !== undefined ||
      exp.mustNotMatch !== undefined;
    if (!asserts) bad(at, "`expect` asserts nothing — a case with no expectation cannot fail");

    for (const a of (exp.attendance ?? []) as unknown[]) {
      if (!isRecord(a) || typeof a.player !== "string") bad(at, "expect.attendance needs a `player`");
      const player: string = a.player;
      if (!STATUSES.includes(String(a.status))) {
        bad(at, `expect.attendance has an unknown status ${JSON.stringify(a.status)}`);
      }
      const known = keys.has(player) || names.some((n) => n.toLowerCase().includes(player.toLowerCase()));
      if (!known && !exp.allowNewMembers) {
        bad(
          at,
          `expect.attendance names "${player}", who is neither a roster key nor an existing ` +
            `member — set allowNewMembers if the case really expects a new person to be created`,
        );
      }
    }
    if (exp.speaks !== undefined && !["silent", "required", "any"].includes(String(exp.speaks))) {
      bad(at, `expect.speaks must be silent | required | any, got ${JSON.stringify(exp.speaks)}`);
    }
    for (const src of [...((exp.mustMatch ?? []) as string[]), ...((exp.mustNotMatch ?? []) as string[])]) {
      try {
        new RegExp(src);
      } catch {
        bad(at, `expect regex /${src}/ does not compile`);
      }
    }

    if (parsed.history !== undefined) {
      if (!Array.isArray(parsed.history)) bad(at, "`history` must be an array");
      for (const h of parsed.history as unknown[]) {
        if (!isRecord(h) || typeof h.body !== "string") bad(at, "every history line needs a `body`");
      }
    }

    cases.push(parsed as unknown as CorpusCase);
  }

  return cases;
}

/** Load + validate `incidents.jsonl`. */
export function loadCorpus(file: string = CORPUS_PATH): CorpusCase[] {
  return parseCorpus(readFileSync(file, "utf8"));
}

/** Cases runnable in stubbed mode (they carry a route for the seam). */
export function stubbableCases(cases: CorpusCase[]): CorpusCase[] {
  return cases.filter((c) => c.messages.some((m: CorpusMessage) => m.route !== undefined));
}

/** Helper the runner uses to seed a match with an initial squad. */
export function initialAttendance(c: CorpusCase): Array<{ key: string; status: AttStatus }> {
  return c.world.attendance ?? [];
}
