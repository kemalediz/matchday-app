-- Organisation."lastParticipantSweepAt": the participant sweep's own
-- clock, split out from the members' sightings (2026-09-09).
--
-- WHY THIS COLUMN EXISTS
-- ----------------------
-- `Membership."lastSeenInGroupAt"` had exactly one writer, the bot's
-- startup participant sweep, and that sweep has been failing since
-- 2026-07-07: whatsapp-web.js's injected page code is out of step with
-- the live WhatsApp Web build, so the chat resolves and its participant
-- list comes back EMPTY without throwing. Sutton FC has 74 memberships,
-- 64 carrying a sighting, the newest 07/07 16:08. A real player added on
-- Monday cannot mark himself in on the web app.
--
-- The fix on the application side is a SECOND writer that needs nothing
-- from the broken injected layer: every inbound group message proves its
-- sender was in the group, so a resolved sender's message refreshes that
-- member's `lastSeenInGroupAt` (src/lib/group-sighting.ts).
--
-- That second writer breaks something if this column does not exist.
-- Three places -- the web app's self-IN gate, the admin players banner,
-- and the `sweep-stale` health alert -- derived "is the sweep healthy?"
-- from `MAX(Membership."lastSeenInGroupAt")` across the org. Once a
-- message can move that MAX, ONE chatty player makes a dead sweep look
-- healthy, and all three go quiet at once: the degraded mode that
-- currently lets nine real Sutton players through would switch itself
-- off for exactly the people it protects, the dashboard banner would
-- disappear, and the alert would stop firing on a live outage.
--
-- So the two facts become two columns:
--   Membership."lastSeenInGroupAt"       did we ever see THIS PERSON in
--                                        the group (sweep OR their own
--                                        message; both are proof)
--   Organisation."lastParticipantSweepAt" when a full roster READ last
--                                        succeeded (sweep only)
--
-- Only the second can license "never seen, therefore not in the group".
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- 1. One ADD COLUMN, NULLABLE, no DEFAULT -- Postgres does not rewrite
--    the table and no existing row changes.
-- 2. One backfill UPDATE, setting each org's new clock to the newest
--    sighting anywhere in that org -- which is precisely the expression
--    the three read sites compute today. Behaviour is therefore
--    IDENTICAL at the moment this lands, and only diverges afterwards,
--    as messages start refreshing sightings while the sweep stays dead.
--    For Sutton FC that value is 2026-07-07 16:08, i.e. still stale,
--    i.e. the degraded mode stays on and the banner stays up, which is
--    the truth.
-- 3. Orgs with no sighting at all keep NULL, which every read site
--    already treats as "never swept" (stale, degraded) -- unchanged.
--
-- It does NOT: touch "Membership" in any way, drop or rename anything,
-- add an index ("Organisation" holds single-digit rows and every read of
-- this column is part of a scan of all of them), or change the behaviour
-- of any query that does not name the new column.
--
-- DEPLOY ORDER: apply this BEFORE the server deploy. Three read sites
-- select the new column, so a new server against an old database would
-- fail on them. An old server against a new database is fine -- it never
-- names the column and the backfilled value is inert to it.
--
-- Rolling back is
--   ALTER TABLE "Organisation" DROP COLUMN "lastParticipantSweepAt";
-- with no data loss outside the new column (its content is derived).
--
-- NOTE ON APPLYING: this repo historically manages schema with
-- `prisma db push` (there is no full migration history -- see
-- prisma.config.ts and the same note on the prior migrations). This file
-- is the canonical, reviewable DDL. `prisma db push` produces the same
-- column but does NOT run the backfill in step 2; if the schema is
-- pushed rather than migrated, run that UPDATE by hand or every org
-- reads as never-swept until its next successful sweep.

-- AlterTable
ALTER TABLE "Organisation" ADD COLUMN "lastParticipantSweepAt" TIMESTAMP(3);

-- Backfill: preserve today's behaviour exactly.
UPDATE "Organisation" AS o
   SET "lastParticipantSweepAt" = m.newest
  FROM (
        SELECT "orgId", MAX("lastSeenInGroupAt") AS newest
          FROM "Membership"
         GROUP BY "orgId"
       ) AS m
 WHERE m."orgId" = o."id"
   AND m.newest IS NOT NULL;
