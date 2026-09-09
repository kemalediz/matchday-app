#!/bin/sh
#
# deploy-pi.sh — the ONLY sanctioned way to restart the MatchTime bot.
#
# ── Why this exists ───────────────────────────────────────────────────
# 2026-07-19: a customer's WhatsApp group received 30+ copies of the same
# roster message in ~20 minutes. Root cause was duplicate bot processes on
# the Pi. Repeated `sudo systemctl restart matchtime-bot.service` had left
# node processes running OUTSIDE systemd's cgroup — we confirmed two
# separate `sh -c node --env-file … src/index.ts` process trees while
# systemd's MainPID tracked only one. Every orphan was logged into the
# same WhatsApp account and every one polled /api/whatsapp/due-posts on a
# 30s timer, so each of them sent the same due message.
#
# `systemctl restart` alone CANNOT fix this: it only stops what it owns.
# This script stops the unit, then kills orphans (cgroup membership is
# exactly what the orphans escaped), verifies zero remain, starts the unit
# ONCE, and verifies EXACTLY ONE instance is running. Anything other than
# 1 is a hard failure with a non-zero exit.
#
# ── Why it is no longer "by pattern" (2026-09-09) ─────────────────────
# A SECOND, unrelated product runs on the same Pi: HomeTenant
# (hometenant-bot.service, ~/hometenant-bot/whatsapp-bot). Its start
# script is character-for-character the same as ours:
#
#     "start": "node --env-file=.env --import tsx src/index.ts"
#
# so `npm start` there produces a command line BYTE-IDENTICAL to ours.
# Observed live on the Pi:
#
#   PID    ARGS                                                CWD
#   1022   /usr/bin/node --env-file=.env --import tsx src/…    ~/hometenant-bot/whatsapp-bot
#   42225  sh -c node --env-file=.env --import tsx src/…       ~/matchtime-bot/whatsapp-bot
#   42226  node --env-file=.env --import tsx src/…             ~/matchtime-bot/whatsapp-bot
#
# The old `pkill -f "$PATTERN"` therefore killed HomeTenant's bot — a live
# product that handles gas-leak reports — and counted HomeTenant's process
# as one of ours, which could either abort a good deploy or mis-report a
# bad one as fine.
#
# THE DISCRIMINATOR IS THE WORKING DIRECTORY. Every process of a bot is
# started with cwd = <install>/whatsapp-bot, and that survives losing the
# cgroup (which is what rules cgroups out — the orphans we must kill are
# precisely the ones that escaped it). The install root is derived from
# THIS SCRIPT'S OWN LOCATION, so a checkout only ever reaps its own
# processes. cwd is read from /proc/<pid>/cwd (Linux/the Pi), falling back
# to `lsof` where /proc is absent (macOS, for local verification).
#
# Rejected alternatives:
#   - cgroup membership: the orphans are by definition outside it.
#   - an env marker on the process: only present if the process was started
#     after the marker shipped, and absent from a hand-run `npm start`, so
#     the orphans that matter most would be unclassifiable.
#   - an absolute path in argv: would require changing package.json's start
#     script and the unit in lockstep, and still misses hand-run bots.
#
# ── Fail CLOSED, in both directions ───────────────────────────────────
# Each matching process is classified MINE / OTHER / UNKNOWN.
#   MINE    (cwd inside our install)  → killed, and counted.
#   OTHER   (cwd anywhere else)       → never killed, never counted. Just
#                                       reported so the log shows it was
#                                       consciously left alone.
#   UNKNOWN (cwd not readable)        → NEVER killed, and BLOCKS the deploy.
#
# UNKNOWN is the interesting case, and it fails closed on both axes: we do
# not kill it (it might be someone else's) AND we do not start alongside it
# (it might be ours). The argument for that direction: a blocked deploy is
# loud, non-destructive, and immediately actionable by a human; a wrong kill
# is a silent outage of another team's product with nothing to catch it, and
# starting next to a possible orphan is the 2026-07-19 flood. The cost of
# the choice is that MatchTime cannot be redeployed until a human resolves
# the ambiguity — that is the cost we are willing to pay.
#
# ── Usage ─────────────────────────────────────────────────────────────
#   On the Pi:      sudo sh ~/matchtime-bot/scripts/deploy-pi.sh
#   From a laptop:  ssh davidediz@matchtime-pi.tail1437f5.ts.net \
#                     'cd ~/matchtime-bot && git pull --ff-only && \
#                      cd whatsapp-bot && npm install --silent && cd .. && \
#                      sudo sh scripts/deploy-pi.sh'
#
# ── Environment overrides ─────────────────────────────────────────────
#   MT_SERVICE            systemd unit name (default matchtime-bot.service)
#   MT_BOT_DIR            ownership root. Defaults to <this script>/../whatsapp-bot.
#                         A process is OURS iff its cwd is this directory or
#                         below it. This is the load-bearing safety setting:
#                         widening it to a shared parent (e.g. /home/davidediz)
#                         would put other products back in the blast radius.
#   MT_BOT_PATTERN        INSTANCE pattern — what one running bot looks like,
#                         used for the final exactly-one assertion. It now
#                         only ever NARROWS the candidate set: whatever it
#                         matches is still filtered by MT_BOT_DIR ownership,
#                         so it can no longer reach outside our install.
#   MT_BOT_ORPHAN_PATTERN KILL pattern — the superset that also matches the
#                         bare `node …` child, since killing only the `sh -c`
#                         wrapper leaves the actual bot running.
#   MT_BOT_LOCK_PATH      pidfile to clear (default /tmp/matchtime-bot.pid)
#   MT_ALLOW_NONROOT=1    skip the root check (cwd of another user's process
#                         is unreadable without it → everything UNKNOWN)
#
# ── Dry-run (used by src/lib/__tests__/deploy-pi.test.ts) ─────────────
#   MT_DEPLOY_DRY_RUN=1 MT_DEPLOY_FAKE_COUNT=3 sh scripts/deploy-pi.sh
# stubs every privileged action and forces the instance count.
#
#   MT_DEPLOY_DRY_RUN=1 MT_DEPLOY_FAKE_PROCS=<file> sh scripts/deploy-pi.sh
# additionally replaces the process table with a fixture, so the OWNERSHIP
# logic itself is testable without a Raspberry Pi. The fixture is TSV:
#     <pid>\t<cwd>\t<command line>
# with two sentinels in the cwd column:
#     !UNREADABLE   process exists but its cwd cannot be read → UNKNOWN
#     !GONE         process vanished between listing and inspection → ignored
# Kills and starts mutate a working copy, so the phases see the consequences
# of the phases before them, exactly as on a real machine.
#   MT_DEPLOY_FAKE_START=n  how many instances the stubbed start brings up
#                           (default 1; 0 = failed start, 2 = double start)
#   MT_DEPLOY_FAKE_SELF_ROW=1  inject a fixture row for THIS script's own
#                           pid, to prove pgrep_exclude_self still holds.

set -eu

SERVICE="${MT_SERVICE:-matchtime-bot.service}"
TAB=$(printf '\t')

# ── Where "ours" is ───────────────────────────────────────────────────
# Derived from this script's own path so a checkout can only ever reap the
# processes of that same checkout.
_self=$0
case "$_self" in
  /*) ;;
  *) _self="$(pwd)/$_self" ;;
esac
SCRIPT_DIR=$(cd -P "$(dirname "$_self")" && pwd)
INSTALL_ROOT=$(cd -P "$SCRIPT_DIR/.." && pwd)
BOT_DIR="${MT_BOT_DIR:-$INSTALL_ROOT/whatsapp-bot}"
if [ -d "$BOT_DIR" ]; then
  BOT_DIR=$(cd -P "$BOT_DIR" && pwd)
fi

DRY="${MT_DEPLOY_DRY_RUN:-0}"
FAKE_PROCS="${MT_DEPLOY_FAKE_PROCS:-}"

# The fake process table is a dry-run-only facility. Refuse it in real mode
# rather than silently letting a fixture drive real kills.
if [ -n "$FAKE_PROCS" ] && [ "$DRY" != "1" ]; then
  echo "ERROR: MT_DEPLOY_FAKE_PROCS is only valid with MT_DEPLOY_DRY_RUN=1." >&2
  exit 3
fi

if [ "$DRY" != "1" ]; then
  if [ ! -d "$BOT_DIR" ]; then
    echo "ERROR: cannot determine which processes are MatchTime's." >&2
    echo "       Expected the bot installation at: $BOT_DIR" >&2
    echo "       (derived from this script at $SCRIPT_DIR; override MT_BOT_DIR)" >&2
    echo "       Refusing to kill anything on a command-line pattern alone —" >&2
    echo "       another product on this Pi has an identical one." >&2
    exit 3
  fi
  if [ "$(id -u)" != "0" ] && [ "${MT_ALLOW_NONROOT:-0}" != "1" ]; then
    echo "ERROR: must run as root (sudo sh scripts/deploy-pi.sh)." >&2
    echo "       Without root, systemctl cannot stop the unit and /proc/<pid>/cwd" >&2
    echo "       of another user's process is unreadable, so every candidate would" >&2
    echo "       be UNKNOWN and the deploy would block anyway." >&2
    exit 3
  fi
fi

# How we identify a bot process
# -----------------------------
# `npm start` runs `node --env-file=.env --import tsx src/index.ts`, and npm
# wraps that in `sh -c`. Both the wrapper and the node child are live on the
# Pi at once.
#
# INSTANCE_PATTERN counts wrappers — exactly ONE per running bot, whereas
# tsx/puppeteer can put several node processes behind one bot, so wrappers
# are the reliable unit to count.
#
# ORPHAN_PATTERN is the superset used when killing and when asserting that
# nothing is left before we start: it also matches the bare `node …` child
# (and HomeTenant's `/usr/bin/node …` form, which is then excluded by
# ownership, not by pattern). Killing only the wrapper leaves the actual bot
# process alive and still polling /api/whatsapp/due-posts, which is the very
# flood this script exists to prevent. Widening the kill this way is only
# safe BECAUSE it is scoped to MT_BOT_DIR.
INSTANCE_PATTERN="${MT_BOT_PATTERN:-sh -c node --env-file.*src/index.ts}"
ORPHAN_PATTERN="${MT_BOT_ORPHAN_PATTERN:-node --env-file.*src/index.ts}"

# ── Fake process table plumbing (dry-run only) ────────────────────────
WORK=""
if [ -n "$FAKE_PROCS" ]; then
  WORK=$(mktemp)
  # shellcheck disable=SC2064
  trap "rm -f '$WORK' '$WORK.tmp'" EXIT INT TERM
  cat "$FAKE_PROCS" > "$WORK"
  if [ "${MT_DEPLOY_FAKE_SELF_ROW:-0}" = "1" ]; then
    printf '%s%s%s%s%s\n' "$$" "$TAB" "$BOT_DIR" "$TAB" \
      "sh -c node --env-file=.env --import tsx src/index.ts" >> "$WORK"
    printf '%s%s%s%s%s\n' "$PPID" "$TAB" "$BOT_DIR" "$TAB" \
      "sh -c node --env-file=.env --import tsx src/index.ts" >> "$WORK"
  fi
fi

# ── Reading a process's working directory ─────────────────────────────
# /proc on Linux (the Pi). lsof where there is no /proc, so this script can
# be exercised for real on a developer's Mac. Anything we cannot read comes
# back as !UNREADABLE and is treated as UNKNOWN — never as ours.
proc_cwd() {
  _p=$1
  if [ -d /proc ]; then
    if [ ! -d "/proc/$_p" ]; then
      printf '%s\n' '!GONE'
      return 0
    fi
    # A zombie keeps its /proc entry and its command line but has no cwd
    # link. It is dead — it cannot poll due-posts — so treat it as gone
    # rather than as ambiguous, or a reaped-but-unwaited orphan would
    # block every subsequent deploy.
    if grep -q '^State:[[:space:]]*Z' "/proc/$_p/status" 2>/dev/null; then
      printf '%s\n' '!GONE'
      return 0
    fi
    _c=$(readlink "/proc/$_p/cwd" 2>/dev/null || true)
    if [ -n "$_c" ]; then
      printf '%s\n' "$_c"
    else
      printf '%s\n' '!UNREADABLE'
    fi
    return 0
  fi
  if command -v lsof >/dev/null 2>&1; then
    _c=$(lsof -a -p "$_p" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
    if [ -n "$_c" ]; then
      printf '%s\n' "$_c"
      return 0
    fi
  fi
  printf '%s\n' '!UNREADABLE'
}

# enumerate <pattern> → "<pid>\t<cwd>\t<cmdline>" per matching process.
#
# pgrep_exclude_self: a naive `pgrep -f "sh -c node --env-file"` ALSO matches
# the shell running this very script, because the pattern appears in this
# script's own command line / ancestry. That false positive cost us during
# the 2026-07-19 diagnosis. Our own pid ($$) and our parent's ($PPID) are
# dropped from the match set before anything is counted or killed.
enumerate() {
  _pat=$1
  if [ -n "$FAKE_PROCS" ]; then
    while IFS="$TAB" read -r _p _c _m; do
      case "${_p:-}" in ''|\#*) continue ;; esac
      if [ "$_p" = "$$" ] || [ "$_p" = "$PPID" ]; then continue; fi
      if [ "$_c" = '!GONE' ]; then continue; fi
      if printf '%s\n' "$_m" | grep -Eq -- "$_pat"; then
        printf '%s%s%s%s%s\n' "$_p" "$TAB" "$_c" "$TAB" "$_m"
      fi
    done < "$WORK"
    return 0
  fi
  for _p in $(pgrep -f -- "$_pat" 2>/dev/null || true); do
    if [ "$_p" = "$$" ] || [ "$_p" = "$PPID" ]; then continue; fi
    _m=$(ps -o args= -p "$_p" 2>/dev/null || true)
    if [ -z "$_m" ]; then continue; fi
    _c=$(proc_cwd "$_p")
    if [ "$_c" = '!GONE' ]; then continue; fi
    printf '%s%s%s%s%s\n' "$_p" "$TAB" "$_c" "$TAB" "$_m"
  done
}

# classify <cwd> → mine | other | unknown
classify() {
  case "$1" in
    '!UNREADABLE'|'') echo unknown ;;
    "$BOT_DIR") echo mine ;;
    "$BOT_DIR"/*) echo mine ;;
    *) echo other ;;
  esac
}

# select_class <pattern> <class> → the matching rows
select_class() {
  enumerate "$1" | while IFS="$TAB" read -r _p _c _m; do
    _cc=${_c% (deleted)}
    if [ "$(classify "$_cc")" = "$2" ]; then
      printf '%s%s%s%s%s\n' "$_p" "$TAB" "$_cc" "$TAB" "$_m"
    fi
  done
}

count_class() { select_class "$1" "$2" | wc -l | tr -d ' '; }
pids_class() { select_class "$1" "$2" | cut -f1 | tr '\n' ' '; }

report_class() {
  _label=$3
  select_class "$1" "$2" | while IFS="$TAB" read -r _p _c _m; do
    echo "      [$_label] pid $_p  cwd=$_c  $_m"
  done
}

# kill_set <signal> <pid…> — by PID, never by pattern. Only ever called
# with pids already classified as ours.
kill_set() {
  _sig=$1
  shift
  if [ "$#" -eq 0 ]; then return 0; fi
  if [ "$DRY" = "1" ]; then
    echo "  [dry-run] would run: kill -$_sig $*"
    if [ -n "$FAKE_PROCS" ]; then
      for _p in "$@"; do
        grep -v "^$_p$TAB" "$WORK" > "$WORK.tmp" || true
        mv "$WORK.tmp" "$WORK"
      done
    fi
    return 0
  fi
  # Re-check ownership immediately before signalling. The pid list was
  # computed a moment ago; a pid could in principle have been recycled onto
  # another product's process in between. Cheap insurance on a destructive
  # step, and it keeps "never kill someone else's" true by construction
  # rather than by argument.
  for _p in "$@"; do
    _c=$(proc_cwd "$_p")
    _c=${_c% (deleted)}
    if [ "$_c" = '!GONE' ]; then continue; fi
    if [ "$(classify "$_c")" != "mine" ]; then
      echo "  NOT signalling pid $_p — it is no longer ours (cwd=$_c)" >&2
      continue
    fi
    kill -"$_sig" "$_p" 2>/dev/null || true
  done
}

run_priv() {
  if [ "$DRY" = "1" ]; then
    echo "  [dry-run] would run: $*"
    return 0
  fi
  "$@"
}

fake_bring_up() {
  _n=${MT_DEPLOY_FAKE_START:-1}
  _i=0
  while [ "$_i" -lt "$_n" ]; do
    _i=$((_i + 1))
    _base=$((90000 + _i * 2))
    printf '%s%s%s%s%s\n' "$_base" "$TAB" "$BOT_DIR" "$TAB" \
      "sh -c node --env-file=.env --import tsx src/index.ts" >> "$WORK"
    printf '%s%s%s%s%s\n' "$((_base + 1))" "$TAB" "$BOT_DIR" "$TAB" \
      "node --env-file=.env --import tsx src/index.ts" >> "$WORK"
  done
}

nap() {
  if [ "$DRY" = "1" ]; then return 0; fi
  sleep "$1"
}

# Do we have a process table to reason about? Real mode always does; dry-run
# only when a fixture was supplied (otherwise the legacy MT_DEPLOY_FAKE_COUNT
# path drives the exit-code contract and the process phases are stubbed out).
HAVE_PROCS=1
if [ "$DRY" = "1" ] && [ -z "$FAKE_PROCS" ]; then HAVE_PROCS=0; fi

echo "==> MatchTime bot deploy/restart ($SERVICE)"
echo "    ours = processes with cwd under $BOT_DIR"

# ── 1. Stop the unit ──────────────────────────────────────────────────
echo "--> stopping $SERVICE"
run_priv systemctl stop "$SERVICE" || true
nap 5

# ── 2. Kill OUR leftovers, by pid (orphans are outside the cgroup) ─────
if [ "$HAVE_PROCS" = "1" ]; then
  FOREIGN=$(count_class "$ORPHAN_PATTERN" other)
  if [ "$FOREIGN" != "0" ]; then
    echo "--> $FOREIGN matching process(es) belong to ANOTHER installation; leaving them alone"
    report_class "$ORPHAN_PATTERN" other "not ours"
  fi

  MINE=$(count_class "$ORPHAN_PATTERN" mine)
  if [ "$MINE" != "0" ]; then
    echo "--> $MINE MatchTime orphan(s) survived the stop; killing by pid"
    report_class "$ORPHAN_PATTERN" mine "ours"
    # shellcheck disable=SC2046
    kill_set TERM $(pids_class "$ORPHAN_PATTERN" mine)
    nap 3
    if [ "$(count_class "$ORPHAN_PATTERN" mine)" != "0" ]; then
      echo "--> still alive; escalating to SIGKILL"
      # shellcheck disable=SC2046
      kill_set KILL $(pids_class "$ORPHAN_PATTERN" mine)
      nap 3
    fi
  fi
fi

# ── 3. Verify ZERO of ours (and nothing ambiguous) before starting ────
if [ "$HAVE_PROCS" = "1" ]; then
  BEFORE=$(count_class "$ORPHAN_PATTERN" mine)
  UNSURE=$(count_class "$ORPHAN_PATTERN" unknown)

  if [ "$UNSURE" != "0" ]; then
    echo "" >&2
    echo "########################################################" >&2
    echo "ERROR: $UNSURE process(es) match a bot command line but their" >&2
    echo "       ownership CANNOT be determined (working directory unreadable)." >&2
    echo "########################################################" >&2
    report_class "$ORPHAN_PATTERN" unknown "UNKNOWN" >&2
    echo "" >&2
    echo "Refusing to kill them: they may belong to another product on this Pi" >&2
    echo "(HomeTenant's bot has a byte-identical command line)." >&2
    echo "Refusing to start alongside them: they may be OUR orphans, and that is" >&2
    echo "how the 2026-07-19 flood happened." >&2
    echo "" >&2
    echo "Resolve by hand, then re-run. To inspect one:" >&2
    echo "  sudo readlink /proc/<pid>/cwd   # which installation is it in?" >&2
    echo "  sudo ps -o pid,ppid,user,args -p <pid>" >&2
    echo "Run this script as root if you did not (cwd of another user's" >&2
    echo "process is unreadable otherwise)." >&2
    exit 2
  fi

  if [ "$BEFORE" != "0" ]; then
    echo "ERROR: $BEFORE MatchTime process(es) still running after stop+kill." >&2
    echo "       Refusing to start another — that is exactly how the" >&2
    echo "       2026-07-19 flood happened." >&2
    report_class "$ORPHAN_PATTERN" mine "ours" >&2
    exit 2
  fi
  echo "--> confirmed 0 MatchTime instances running"
fi

# Stale lockfile from a SIGKILLed instance would self-heal anyway (the
# guard probes liveness), but clear it so startup logs stay clean.
run_priv rm -f "${MT_BOT_LOCK_PATH:-/tmp/matchtime-bot.pid}"

# ── 4. Start ONCE ─────────────────────────────────────────────────────
echo "--> starting $SERVICE"
run_priv systemctl start "$SERVICE"
if [ -n "$FAKE_PROCS" ]; then fake_bring_up; fi
nap 10

# ── 5. Verify EXACTLY ONE of OURS ─────────────────────────────────────
if [ "$HAVE_PROCS" = "1" ]; then
  AFTER=$(count_class "$INSTANCE_PATTERN" mine)
  AFTER_UNSURE=$(count_class "$INSTANCE_PATTERN" unknown)
else
  AFTER="${MT_DEPLOY_FAKE_COUNT:-1}"
  AFTER_UNSURE=0
fi

if [ "$AFTER_UNSURE" != "0" ]; then
  echo "" >&2
  echo "########################################################" >&2
  echo "ERROR: $AFTER_UNSURE process(es) of UNDETERMINED ownership are running" >&2
  echo "       a bot command line. Cannot certify a single instance." >&2
  echo "########################################################" >&2
  report_class "$INSTANCE_PATTERN" unknown "UNKNOWN" >&2
  exit 1
fi

if [ "$AFTER" != "1" ]; then
  echo "" >&2
  echo "########################################################" >&2
  echo "ERROR: expected exactly 1 bot instance, found $AFTER" >&2
  echo "########################################################" >&2
  if [ "$AFTER" = "0" ]; then
    echo "The service failed to start. Check:" >&2
    echo "  systemctl status $SERVICE --no-pager" >&2
    echo "  journalctl -u $SERVICE -n 100 --no-pager" >&2
  else
    echo "DUPLICATE INSTANCES — this is the 2026-07-19 flood condition." >&2
    if [ "$HAVE_PROCS" = "1" ]; then
      report_class "$INSTANCE_PATTERN" mine "ours" >&2
      echo "Kill them BY PID and re-run this script:" >&2
      echo "  sudo kill -9 $(pids_class "$INSTANCE_PATTERN" mine)" >&2
    fi
    echo "Do NOT pkill by command-line pattern: HomeTenant's bot on this Pi" >&2
    echo "has an identical one and you would take it down." >&2
  fi
  exit 1
fi

if [ "$DRY" = "1" ]; then
  echo "OK: exactly one instance running (dry-run)"
  exit 0
fi

PID=$(pids_class "$INSTANCE_PATTERN" mine | tr -d ' ')
echo "OK: exactly one instance running (pid $PID)"
systemctl is-active "$SERVICE" || true
exit 0
