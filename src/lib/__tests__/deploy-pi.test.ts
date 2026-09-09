/**
 * scripts/deploy-pi.sh — exit-code contract AND process-ownership contract.
 *
 * The script is the ONLY sanctioned way to restart the Pi bot after the
 * 2026-07-19 duplicate-send incident (hand-run `systemctl restart` left
 * orphan processes outside the cgroup, so instances piled up).
 *
 * Two harnesses, both dry-run so no Raspberry Pi is involved:
 *
 *   MT_DEPLOY_FAKE_COUNT  — legacy. Forces the post-start instance count,
 *                           which pins the exit-code contract.
 *   MT_DEPLOY_FAKE_PROCS  — a fixture process table (TSV: pid, cwd,
 *                           command line). Kills and starts mutate a
 *                           working copy, so each phase sees the
 *                           consequences of the one before it. This is
 *                           what makes the OWNERSHIP logic testable.
 *
 * Why ownership needs testing at all: a second, unrelated product runs on
 * the same Pi. HomeTenant's whatsapp-bot start script is character-for-
 * character identical to MatchTime's, so `npm start` there produces a
 * BYTE-IDENTICAL command line. Killing by pattern took it down. The
 * discriminator is now the working directory.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { statSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "../../../scripts/deploy-pi.sh");

/** Where MatchTime is installed on the Pi, as far as these tests care. */
const MT_DIR = "/srv/matchtime-bot/whatsapp-bot";
/** The other product on the same Pi. Same command line, different install. */
const HT_DIR = "/srv/hometenant-bot/whatsapp-bot";

/** npm's wrapper — one per running bot. This is the counted unit. */
const WRAPPER = "sh -c node --env-file=.env --import tsx src/index.ts";
/** The node child the wrapper leaves behind. */
const CHILD = "node --env-file=.env --import tsx src/index.ts";
/** HomeTenant's service form: node invoked directly, absolute path. */
const HT_SERVICE = "/usr/bin/node --env-file=.env --import tsx src/index.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "deploy-pi-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Row = [pid: string | number, cwd: string, cmdline: string];

function fixture(name: string, rows: Row[]): string {
  const p = path.join(dir, `${name}.tsv`);
  writeFileSync(p, rows.map((r) => r.join("\t")).join("\n") + "\n");
  return p;
}

function run(env: Record<string, string>) {
  const r = spawnSync("sh", [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, MT_DEPLOY_DRY_RUN: "1", ...env },
  });
  return { ...r, out: r.stdout + r.stderr };
}

/** Run against a fixture process table. */
function runProcs(rows: Row[], env: Record<string, string> = {}) {
  const name = Math.random().toString(36).slice(2);
  return run({
    MT_DEPLOY_FAKE_PROCS: fixture(name, rows),
    MT_BOT_DIR: MT_DIR,
    ...env,
  });
}

/** Every pid the script said it would signal. */
function killedPids(out: string): string[] {
  const pids: string[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/would run: kill -\w+ (.*)$/);
    if (m) pids.push(...m[1].trim().split(/\s+/).filter(Boolean));
  }
  return pids;
}

// ── The original exit-code contract, unchanged ────────────────────────

describe("scripts/deploy-pi.sh — exit-code contract", () => {
  const runDryRun = (fakeCount: string) => run({ MT_DEPLOY_FAKE_COUNT: fakeCount });

  it("is executable", () => {
    // eslint-disable-next-line no-bitwise
    expect(statSync(SCRIPT).mode & 0o111).toBeGreaterThan(0);
  });

  it("exits 0 when exactly one instance is running afterwards", () => {
    const r = runDryRun("1");
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toMatch(/exactly one instance/i);
  });

  it("exits NON-ZERO when zero instances are running afterwards", () => {
    const r = runDryRun("0");
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/expected exactly 1/i);
  });

  it("exits NON-ZERO when MORE THAN ONE instance is running afterwards", () => {
    // This is the incident condition. It must be loud, not silent.
    const r = runDryRun("3");
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/expected exactly 1/i);
    expect(r.out).toMatch(/3/);
  });

  it("counts instances in a way that cannot match its own shell", () => {
    // `pgrep -f "sh -c node --env-file"` also matches the invoking
    // shell's own command line — that false positive cost us during
    // diagnosis. The script must exclude itself and its children.
    const r = spawnSync("grep", ["-c", "pgrep_exclude_self\\|-a $$\\|\\$\\$", SCRIPT], {
      encoding: "utf8",
    });
    expect(Number(r.stdout.trim())).toBeGreaterThan(0);
  });
});

// ── Ownership: the whole point of the 2026-09-09 change ───────────────

describe("scripts/deploy-pi.sh — kills only MatchTime's own processes", () => {
  it("kills a MatchTime orphan that escaped systemd's cgroup", () => {
    // The original purpose of this script. Must not regress.
    const r = runProcs([
      [42225, MT_DIR, WRAPPER],
      [42226, MT_DIR, CHILD],
    ]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/2 MatchTime orphan\(s\) survived the stop/);
    expect(killedPids(r.out)).toEqual(expect.arrayContaining(["42225", "42226"]));
    expect(r.out).toMatch(/confirmed 0 MatchTime instances running/);
    expect(r.out).toMatch(/exactly one instance/i);
  });

  it("kills the bare node child, not just npm's sh -c wrapper", () => {
    // Killing only the wrapper leaves the actual bot alive and still
    // polling /api/whatsapp/due-posts — the flood, with a green tick.
    const r = runProcs([[42226, MT_DIR, CHILD]]);
    expect(r.status, r.out).toBe(0);
    expect(killedPids(r.out)).toContain("42226");
  });

  it("does NOT kill HomeTenant, whose command line is byte-identical", () => {
    // THE headline case. Same argv, different installation.
    const r = runProcs([
      [1022, HT_DIR, HT_SERVICE],
      [2001, HT_DIR, WRAPPER], // hand-run `npm start` for re-pairing
      [2002, HT_DIR, CHILD],
      [42225, MT_DIR, WRAPPER],
      [42226, MT_DIR, CHILD],
    ]);
    expect(r.status, r.out).toBe(0);

    const killed = killedPids(r.out);
    expect(killed).toEqual(expect.arrayContaining(["42225", "42226"]));
    for (const foreign of ["1022", "2001", "2002"]) {
      expect(killed, `HomeTenant pid ${foreign} must never be signalled`).not.toContain(
        foreign,
      );
    }
    expect(r.out).toMatch(/3 matching process\(es\) belong to ANOTHER installation/);
    expect(r.out).toMatch(/leaving them alone/);
  });

  it("kills nothing at all when only HomeTenant is running", () => {
    const r = runProcs([
      [1022, HT_DIR, HT_SERVICE],
      [2001, HT_DIR, WRAPPER],
    ]);
    expect(r.status, r.out).toBe(0);
    expect(killedPids(r.out)).toEqual([]);
    expect(r.out).not.toMatch(/MatchTime orphan\(s\) survived/);
  });

  it("cannot be widened past its own installation by MT_BOT_PATTERN", () => {
    // The escape hatch now only ever NARROWS: whatever the pattern
    // matches is still filtered by ownership.
    const r = runProcs(
      [
        [1022, HT_DIR, HT_SERVICE],
        [42225, MT_DIR, WRAPPER],
      ],
      { MT_BOT_PATTERN: ".", MT_BOT_ORPHAN_PATTERN: "." },
    );
    expect(killedPids(r.out)).not.toContain("1022");
    expect(killedPids(r.out)).toContain("42225");
  });
});

describe("scripts/deploy-pi.sh — the single-instance assertion counts only ours", () => {
  it("passes with exactly one of ours, however many of HomeTenant's are up", () => {
    const r = runProcs([
      [1022, HT_DIR, HT_SERVICE],
      [2001, HT_DIR, WRAPPER],
      [2003, HT_DIR, WRAPPER],
    ]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/exactly one instance/i);
  });

  it("fails when OUR instance did not come up, even with HomeTenant's running", () => {
    // Before the fix, HomeTenant's wrappers padded the count to 1+ and a
    // failed start could read as success.
    const r = runProcs(
      [
        [2001, HT_DIR, WRAPPER],
        [2003, HT_DIR, WRAPPER],
      ],
      { MT_DEPLOY_FAKE_START: "0" },
    );
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/expected exactly 1 bot instance, found 0/);
  });

  it("fails loudly on duplicates of ours, and does not advise pkill by pattern", () => {
    const r = runProcs([], { MT_DEPLOY_FAKE_START: "2" });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/expected exactly 1 bot instance, found 2/);
    expect(r.out).toMatch(/DUPLICATE INSTANCES/);
    expect(r.out).toMatch(/kill -9 90002 90004/);
    expect(r.out).toMatch(/Do NOT pkill by command-line pattern/);
    // The old remediation hint was `sudo pkill -9 -f '<pattern>'`, which
    // would have taken HomeTenant down by hand.
    expect(r.out).not.toMatch(/sudo pkill -9 -f/);
  });
});

describe("scripts/deploy-pi.sh — fails closed when ownership is undeterminable", () => {
  it("refuses to kill an unclassifiable process AND refuses to start", () => {
    const r = runProcs([
      [7777, "!UNREADABLE", WRAPPER],
      [42225, MT_DIR, WRAPPER],
    ]);
    expect(r.status).toBe(2);
    expect(killedPids(r.out)).not.toContain("7777");
    expect(r.out).toMatch(/ownership CANNOT be determined/);
    expect(r.out).toMatch(/\[UNKNOWN\] pid 7777/);
    expect(r.out).toMatch(/Refusing to kill them/);
    expect(r.out).toMatch(/Refusing to start alongside them/);
    // It must not have gone on to start a second instance.
    expect(r.out).not.toMatch(/would run: systemctl start/);
  });

  it("ignores a process that vanished between listing and inspection", () => {
    // A race is not an ambiguity — the process is simply gone.
    const r = runProcs([
      [8888, "!GONE", WRAPPER],
      [42225, MT_DIR, WRAPPER],
    ]);
    expect(r.status, r.out).toBe(0);
    expect(killedPids(r.out)).toEqual(["42225"]);
  });

  it("refuses to let a fixture process table drive a REAL run", () => {
    const r = spawnSync("sh", [SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        MT_DEPLOY_DRY_RUN: "0",
        MT_DEPLOY_FAKE_PROCS: fixture("real-mode", [[42225, MT_DIR, WRAPPER]]),
      },
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/only valid with MT_DEPLOY_DRY_RUN=1/);
  });
});

describe("scripts/deploy-pi.sh — pgrep_exclude_self", () => {
  it("does not count or kill the shell running the script itself", () => {
    // MT_DEPLOY_FAKE_SELF_ROW injects rows for $$ and $PPID with OUR cwd
    // and a matching command line: the worst case for a naive count.
    const r = runProcs([], { MT_DEPLOY_FAKE_SELF_ROW: "1" });
    expect(r.status, r.out).toBe(0);
    expect(killedPids(r.out)).toEqual([]);
    expect(r.out).not.toMatch(/MatchTime orphan\(s\) survived/);
    expect(r.out).toMatch(/confirmed 0 MatchTime instances running/);
    expect(r.out).toMatch(/exactly one instance/i);
  });

  it("still spots a real orphan while ignoring itself", () => {
    const r = runProcs([[42225, MT_DIR, WRAPPER]], { MT_DEPLOY_FAKE_SELF_ROW: "1" });
    expect(r.status, r.out).toBe(0);
    expect(killedPids(r.out)).toEqual(["42225"]);
  });
});
