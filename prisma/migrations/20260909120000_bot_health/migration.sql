-- BotHealth: the WhatsApp bot's self-report, one row per org (2026-09-09).
--
-- WHAT THIS IS FOR
-- ----------------
-- The 2026-08-30 independent audit's headline finding was that every
-- failure signal in the WhatsApp layer is a `console.error` on a
-- Raspberry Pi that nobody reads: no heartbeat, no server-side staleness
-- check, no alert. That is why the August outage lasted three days, why
-- the participant sweep has been dead since 2026-07-07 without anyone
-- being told, and why an @-mention bug corrupted stored names for months
-- before the owner complained.
--
-- This table is where the Pi's report lands so something server-side can
-- notice both what it says AND its absence.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive:
--   1. CREATE TABLE "BotHealth"  — new, empty, no foreign keys.
--   2. one unique index on "orgId" and one plain index on
--      "lastHeartbeatAt" — both on a new empty table.
--
-- It does NOT: rewrite a row, backfill anything, drop or rename
-- anything, alter an existing table, add a constraint to an existing
-- table, or change any behaviour of any existing query. Nothing outside
-- the two new endpoints reads or writes it.
--
-- Rolling back is `DROP TABLE "BotHealth"`, with no data loss outside
-- the new table.
--
-- NO FOREIGN KEY TO "Organisation", deliberately, matching "BotJob"
-- next door: this is operational telemetry about a process, not domain
-- data, and a health row that blocks or cascades an org edit would be a
-- monitoring table causing the outage it exists to report.
--
-- NOTE ON APPLYING: this repo historically manages schema with
-- `prisma db push` (there is no full migration history — see
-- prisma.config.ts, and the same note on the prior migrations). This
-- file is the canonical, reviewable DDL. `prisma db push` produces an
-- identical result here because the table uses no triggers and no
-- non-Prisma DDL.

-- CreateTable
CREATE TABLE "BotHealth" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "waGroupId" TEXT,
    -- NULLABLE, and the distinction is load-bearing: NULL means no
    -- heartbeat has EVER arrived, which is exactly what a healthy Pi
    -- running a pre-2026-09-09 build looks like. A row can exist with
    -- this still NULL, because the server-side alert rules fire off data
    -- an older Pi already produces and their dedupe state lives here.
    "lastHeartbeatAt" TIMESTAMP(3),
    "processStartedAt" TIMESTAMP(3),
    "botVersion" TEXT,
    "seen" INTEGER NOT NULL DEFAULT 0,
    "buffered" INTEGER NOT NULL DEFAULT 0,
    "synthetic" INTEGER NOT NULL DEFAULT 0,
    "reconstructed" INTEGER NOT NULL DEFAULT 0,
    "notGroup" INTEGER NOT NULL DEFAULT 0,
    "degradedEnrichment" INTEGER NOT NULL DEFAULT 0,
    "nameless" INTEGER NOT NULL DEFAULT 0,
    "reactFailures" INTEGER NOT NULL DEFAULT 0,
    "flushFailures" INTEGER NOT NULL DEFAULT 0,
    "droppedMessages" INTEGER NOT NULL DEFAULT 0,
    "degradedCapabilities" TEXT[],
    -- Alert dedupe lives on the health row rather than in
    -- "SentNotification": it is a property of this org's health, not of
    -- a match, and "lastAlertCodes" is what makes "a NEW fault appeared"
    -- (speak now) distinguishable from "the same fault is still there"
    -- (wait for the repeat window).
    "lastAlertAt" TIMESTAMP(3),
    "lastAlertCodes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotHealth_pkey" PRIMARY KEY ("id")
);

-- One row per org: the heartbeat is an UPSERT on this key, so a bot that
-- restarts twice a minute cannot grow the table.
CREATE UNIQUE INDEX "BotHealth_orgId_key" ON "BotHealth"("orgId");

-- The staleness sweep scans by recency.
CREATE INDEX "BotHealth_lastHeartbeatAt_idx" ON "BotHealth"("lastHeartbeatAt");
