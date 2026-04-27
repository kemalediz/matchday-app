---
name: Skills
description: How to work effectively in this codebase — tooling, patterns, and operational rituals
type: reference
originSessionId: 70ec7d56-8494-404f-90f8-117487d2d23f
---
A condensed quick-reference for the routines and patterns that make changes ship cleanly here. Detailed context lives in `project_matchtime.md` and `reference_*.md`; this file is the "what do I always do".

---

## Stack at a glance

- **Next.js 16.2 beta** (Turbopack). Breaking changes vs training data — read `node_modules/next/dist/docs/` before guessing.
- **Prisma 7.5** with `@prisma/adapter-pg` (Postgres on Supabase). Schema generates into `src/generated/prisma/` (gitignored) — `build` script runs `prisma generate && next build`.
- **NextAuth v5** with Credentials + Google + JWT sessions.
- **Tailwind v4** + plain utility classes (shadcn primitives almost all replaced — don't reintroduce them).
- **Anthropic SDK** — Haiku 4.5 for high-frequency message analyzer (10-min batches, 1h prompt cache); Sonnet 4.5 for one-shots (onboarding analyzer, hybrid balancer).
- **WhatsApp bot** in `whatsapp-bot/` — `whatsapp-web.js` on a Raspberry Pi 5, polls `/api/whatsapp/due-posts` every 5 min and dispatches dumb instructions.

## Repo layout shortcuts

- `src/lib/` — server-only helpers (db, auth, bot scheduler, message analyzer, balancer, magic-link, …).
- `src/app/` — Next App Router. `actions/` holds `"use server"` actions; `api/whatsapp/*` is the bot's HTTP surface.
- `prisma/schema.prisma` — single source of truth. Migrations history is out of sync from earlier debugging — use `prisma db push`, NOT `prisma migrate`.
- `scripts/` — one-off TS scripts, run with `node --env-file=.env --import tsx scripts/foo.ts`. Use `import { PrismaClient } from "../src/generated/prisma/client.ts"` (with `.ts` extension; tsx resolves it, plain Node ESM doesn't).
- `whatsapp-bot/` — separate npm app, bot only. Versioned in the same repo but only deploys when the Pi pulls.

## Local commands I always reach for

```bash
# TypeScript only — fastest sanity check
PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH npx tsc --noEmit

# Full build before pushing — catches Server-Action async violations + duplicate routes
PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH npm run build

# Apply schema changes (NOT migrate — history is out of sync)
PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH npx prisma db push
PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH npx prisma generate

# Vercel deploy status (or check the dashboard)
PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH vercel ls --scope kemaledizs-projects matchday
```

The `PATH` prefix is because the user's shell defaults to Node 16, which Prisma 7 + Vercel CLI both reject (`ReferenceError: ReadableStream is not defined`).

## Standing rule: auto-deploy to the Pi after every push

After **every** `git push` that lands on `main`, even server-only changes:

```bash
ssh davidediz@matchtime-pi.tail1437f5.ts.net 'cd ~/matchday-bot && git pull --ff-only && sudo systemctl restart matchday-bot.service'
```

For bot code changes also run `cd whatsapp-bot && npm install --silent` between pull and restart. Verify with `systemctl status matchday-bot.service --no-pager` — should be `active (running)` within ~10s.

If SSH returns "additional check required" with a `login.tailscale.com/a/...` URL, ask Kemal to click it once.

## Verification tools / pre-built scripts

The 90+ scripts in `scripts/` follow a `peek-*`, `check-*`, `find-*`, `fix-*` naming convention. Common ones:
- `peek-mom-apr21.ts` — read MoM votes for the latest match
- `check-bot-jobs.ts` — see what's queued / sent
- `check-state.ts` / `check-lineup.ts` — current attendance state
- `manual-attendance.ts` — fallback when wweb.js `fetchMessages` flakes
- `wipe-org.ts` — generic org delete (dry-run by default; `--apply`)
- `record-score.ts` — manual score entry
- `dbquery.ts` — read-only inspector

Pattern: peek before fixing, fix in a dedicated script when you can, never in a REPL.

## Deployment cadence

Atomic commits with conventional prefixes. Recent style:

```
feat(scope): short imperative
fix(scope): short imperative
chore(scope): short imperative
```

Common scopes: `balancer`, `mom`, `scheduler`, `analyze`, `reactions`, `admin/players`, `admin/organisations`, `onboarding`, `reply`, `chase`. Always include a body explaining the *why* and a `Co-Authored-By: Claude …` trailer.

Ship small + push + (Pi pull) + restart. Don't batch a week of work into one commit.

## Bot architecture

The bot is **dumb**. The server tells it what to post, with stable idempotency keys:

```
Pi every 5 min:
  GET /api/whatsapp/due-posts?groupId=X
    → [{ kind, key, ... }]
  for each instruction:
    execute (sendMessage / poll / DM / react)
    POST /api/whatsapp/ack { key, kind, waMessageId }
      → server upserts SentNotification(key)
```

Adding a new bot capability = new entry in the `DueInstruction` union in `src/lib/bot-scheduler.ts` + new case in `whatsapp-bot/src/scheduler.ts` + ACK handler if it needs DB updates. Never put scheduling logic on the bot — server owns "when".

When a bot↔server protocol field changes (new `DueInstruction` kind, new field on existing kind), call out **"needs Pi redeploy"** in the commit body. Older bot builds silently skip unknown kinds; ACK won't resolve until the Pi has the matching code.

## LLM design rules

1. **LLM for understanding, deterministic code for compute.** Classify intent / extract entities / phrase replies → LLM. Score / balance / Elo / cron windows → code. Hybrid (Phase 4 balancer) is usually better than all-LLM when there's a ground-truth right answer.
2. **Don't trust the LLM with anything visible to the group.** Post-process every LLM-emitted reply server-side. Existing post-processors: `enforceProximity` (TZ + temporal phrasing), `enforceCanonicalRoster` (numbered list + count + "need N more"). Prompt rules fail; deterministic rewriters succeed.
3. **Cache aggressively.** System prompt + match/squad context get `cache_control: { type: "ephemeral", ttl: "1h" }`. Only fresh chat history + the current batch are paid in full each call.
4. **Falls open by default.** If the API key is missing or Anthropic errors, return empty/skip — never block the user-visible flow.
5. **Right model for the right job.** Haiku for high-frequency (analyzer batches every 10 min). Sonnet for one-shots (onboarding analyzer, hybrid balancer) — accuracy beats cost on something that runs once per match/org.

## DB access patterns

- Always use the **`aws-1`** Supabase pooler (`aws-1-eu-west-1.pooler.supabase.com`). `aws-0` was the original buggy host.
- Schema changes go through `prisma db push`, not `migrate`.
- Prefer `groupBy` over N+1 query loops; the codebase has a few `getMomSummaries`-style helpers that batch lookups for a list of matches.
- Trim `.env`-loaded secrets defensively — Vercel's dashboard occasionally appends a stray `\n` to pasted values (`AUTH_SECRET`, `EMAIL_FROM` have both been hit).

## Phone normalisation

`src/lib/phone.ts#normalisePhone` strips Unicode bidi marks (U+200E/200F, U+202A-E) before anything else — WhatsApp / iOS contacts silently inject these on paste. Two visually identical numbers compare unequal otherwise. Route every new phone-entry path through `normalisePhone`.

For matching against a stored phone (already E.164), allow suffix matches in either direction so country-code mismatches between "0xxx" and "+44xxx" don't drop signal.

## Schema cascade conventions

When deleting things, walk the right order:
1. `Match` (cascades to `Attendance`, `TeamAssignment`, `Rating`, `MoMVote`, `SentNotification`, `PendingBenchConfirmation`, `RatingAdjustment`).
2. `Activity` (cascades to `PlayerActivityPosition`).
3. `BotJob`, `AnalyzedMessage`, `Sport` (no FK back-pressure but explicit clean-up).
4. `Organisation` (cascades `Membership`).
5. Orphan synthetic users (`onboarding+*`, `provisional+*`, `wa-*` whose only org was the one being deleted) — never real OAuth users.

Use `db.$transaction(async (tx) => …, { timeout: 60_000 })` for anything that spans more than two writes.

## Time / TZ

All user-facing times are **Europe/London**. The cron runs in UTC. `src/lib/london-time.ts` wraps `date-fns-tz` with `londonWallClockToUtc` and `formatLondon` — DST-safe. Plain `setHours(21, 30)` on Vercel produces 21:30 UTC = 22:30 BST in summer; the wrappers prevent that.

`londonHour(at)` and `londonDateKey(at)` are the standard time-of-day / date-of-day helpers used throughout the bot scheduler.

## Idempotency keys

Every queued bot instruction has a stable `key` so the same instruction never fires twice. Format conventions:

- `<matchId>:<kind>` — match-scoped event (e.g. `matchABC:announce-match`).
- `<matchId>:<kind>:<userId>` — per-user DM.
- `<matchId>:<kind>:<dayKey>` — daily firing (`evening-update:2026-04-27`).
- `org-<orgId>:<kind>` — org-scoped (e.g. `org-foo:bot-intro`).
- `botjob-<id>` — ad-hoc admin queue.
- `retro-react-<id>` — RetroReaction queue.

The server records `SentNotification` rows on ACK; the next compute step builds a `sentKeys` set and skips anything already there.

## "Never break the live org" safety

Schema changes go in **strictly additive** — nullable + defaulted columns, new tables — so rolling back is safe. Sutton FC is live production; Kemal's Tuesday match depends on this code working every week.

For destructive operations (drop a column, change a status enum, delete data), check with the user first — even when superadmin tools exist.
