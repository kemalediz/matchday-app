# HomeTenant's WhatsApp layer, reviewed against MatchTime's defects

**2026-09-09. Read-only investigation, no HomeTenant file was changed.**
Repo: `/Users/kemal/Projects/Cressoft/HomeTenant/`.

Kemal asked whether HomeTenant would suffer the same failures MatchTime
spent this week fixing, since both are `whatsapp-web.js` bots on the same
Raspberry Pi. Short answer: **mostly no, and in several respects HomeTenant
is ahead.** The exceptions are one genuine gap, one deliberate trade worth
revisiting, and one hazard that was MatchTime's fault.

---

## What HomeTenant is

An AI maintenance line for UK HMO landlords. Tenants WhatsApp a number; the
server classifies (language, severity, safety, multi-job), dispatches
engineers, and handles scheduling, rent confirmation, compliance
certificates, prospect intake and owner invoice approvals. The bot is
deliberately dumb and stateless; all logic is server-side.

**Commercially live** as of early September: Stripe live mode, public
signup. Whether real tenants have been onboarded is unconfirmed. Treat the
line as live either way.

Its bot is DM-only. Groups, status broadcasts and self-messages are
rejected at the door (`whatsapp-bot/src/index.ts:211-213`). That single
design choice removes several of MatchTime's problems by construction.

---

## The eight defects, checked

| # | Defect | HomeTenant |
|---|---|---|
| 1 | Corrupted `@`-mentions | **Not applicable.** DM-only, no mention resolution, no `pushname` anywhere. Names come from its own DB. |
| 2 | Whole-message peels | **Had it, already fixed.** Regex fast-paths deleted in `093b4e7` ("the model decides what a tenant meant, not a regex"). The move-out-video branch "used to return UNCONDITIONALLY" above every safety gate; fixed with the incident written into the code. |
| 3 | Silent failure, no health signal | **HAS IT. The real gap.** |
| 4 | Reactions failing silently | **Not applicable.** The bot never reacts; every ack is a text reply. |
| 5 | Message loss on a broken build | **Fixed, thoroughly.** `ingestWithSafetyNet` retries transient failures and, on exhaustion, replies to the tenant with emergency routes, because "an unknown message is not a safe one to treat as routine". |
| 6 | Duplicate processes | **Fixed differently but well.** Their own 2026-07-20 incident. `ExecStartPre` pkills a scoped pattern and clears Singleton locks; `KillMode=control-group`. No deploy script, though. |
| 7 | Unattributable senders | **Not silent.** Unknown number gets a real reply, or routes to prospect intake. |
| 8 | Claim-on-dispatch | **Opposite trade, deliberate.** See below. |

Library version: declares `^1.26.1-alpha.3`, but the lockfile and the Pi
both run **1.34.7**. The caret drifted a long way, though consistently.

---

## The one real gap: nothing is watching

Same finding as MatchTime's, and for the same reason. Everything is
`console.error` into a `bot.log` nobody reads. No heartbeat, no
server-side staleness check, no alert. The server records nothing when the
bot polls its outbox.

Worse than MatchTime's version in one specific way: `StartLimitBurst=5` /
`StartLimitIntervalSec=300` means five failures in five minutes leaves the
service **permanently stopped, with nobody told**. That is the shape of
their July crash loop, which was noticed by looking.

Dead-lettered outbox rows are equally invisible: no dashboard view or
notification reads `failedAt`, so a dead-lettered rent reminder just
vanishes into a database flag.

**HomeTenant's health check is easier than MatchTime's, not harder.**
MatchTime had to ask "is there a fixture within 36 hours?" because its
traffic is event-shaped and silence is usually just a quiet week.
HomeTenant's bot polls its outbox **every 8 seconds regardless of
traffic**, so the equivalent is simply: stamp `lastBotPollAt` on every
outbox GET, and have the existing 15-minute scheduler cron alert when it
exceeds a few minutes. Resend and web-push already exist in that repo. No
new infrastructure.

---

## The deliberate trade worth revisiting

MatchTime chose **at-most-once** delivery (claim-on-dispatch) after
flooding a customer group with 30+ duplicates. HomeTenant chose
**at-least-once**, and says so in the code: a stale claim is re-served
after two minutes, "retry, at the cost of a possible duplicate: better
than a lost message".

The consequence is real: if the bot sends a batch and then crashes before
reporting, **the whole batch is re-sent to real tenants** about two minutes
later. Inbound is properly idempotent (`Message.waMessageId` unique), and
they have closed two other double-send holes recently, so this is a
considered position rather than an oversight. But the blast radius could be
cut cheaply by reporting each row as it sends rather than once per batch, so
a report failure re-sends one message instead of up to fifty.

---

## The hazard that was ours

`matchtime/scripts/deploy-pi.sh` killed processes by the pattern
`sh -c node --env-file.*src/index.ts`. HomeTenant's documented re-pairing
path is `npm run start`, which produces a **byte-identical** command line.
Their systemd unit escapes it only by luck, because it runs `node`
directly.

So a MatchTime deploy could kill a hand-started HomeTenant bot, and
MatchTime's own single-instance assertion would count HomeTenant's process
as its own. Verified live: only the working directory distinguishes them.

**Fixed in MatchTime PR #67** (`76fd376`): kills are scoped to the
installation, derived from the script's own path, and an unclassifiable
process blocks the deploy rather than being killed.

**What HomeTenant should know:**
- their tooling must not `pkill -f` on that command line either, or it
  takes MatchTime down. The same cwd scoping works with
  `~/hometenant-bot/whatsapp-bot`;
- "our service form is different" is not a defence, because the README's
  `npm run start` path matched exactly;
- if MatchTime's deploy ever cannot classify a HomeTenant pid it now
  refuses to deploy rather than kill it. That usually means a permissions
  problem reading `/proc/<pid>/cwd`.

---

## Recommended order

1. **Bot-liveness heartbeat and staleness alert.** Live product, public
   signup, safety-critical traffic. A dead Pi is currently discovered by
   accident, and `StartLimitBurst` can park the service silently.
2. **Surface dead-letters and the send-failure backlog.** A mistyped
   engineer phone today means the dispatch DM silently no-ops.
3. **Shrink the outbox duplicate window.** Cheap, and duplicates to real
   tenants are brand-damaging.
4. **A deploy script with a single-instance assertion.** The systemd unit
   is good; the manual rsync ritual is where the next orphan comes from.
5. **Multi-intent residue.** `routeIntent` picks one top-level intent per
   message, so a mixed message is half-answered. Safety always wins the
   tie, which is the correct failure direction, so this is lowest priority.

---

## Found in passing, not WhatsApp defects, higher stakes than most of the above

- **One Supabase project serves dev and prod**, so `prisma migrate dev`
  locally writes to production.
- **A suspected stale `STRIPE_WEBHOOK_SECRET`** in production: a paying
  customer could be charged and locked out. Already top of their own list.
- **Two partial indexes exist only in migrations and are invisible to
  Prisma**, so a future `migrate diff` tidy-up would silently drop a
  double-send backstop.

---

## Method note

This review was produced by a subagent given the eight defects and told to
cite file and line for every claim, to say "unsure" rather than guess, and
to report anything we did NOT have. The three items in the section above
came from that last instruction and are the most valuable part of the
report. The cross-repo kill hazard was verified independently against the
live Pi before being acted on.
