-- Rollback for drizzle/migrations/0007_guardian_link_otp.sql
--
-- ===========================================================================
-- WHAT THIS DESTROYS, STATED PLAINLY.
--
-- `link_code_otp_challenges` holds in-flight second factors and their attempt
-- counters. Dropping it is safe in the way losing a session is safe: every row
-- is a challenge somebody is part-way through, so the cost is that they request
-- a new code. Nothing here is a record of a decision, unlike
-- `notification_preferences`.
--
-- THE ONE THING THAT DOES NOT ROLL BACK CLEANLY IS THE NULL EXPIRY.
--
-- Restoring `expires_at NOT NULL` fails outright if any persistent code has
-- been issued since the migration ran — which is the normal case, because
-- persistent codes are the point of it. So the rollback STAMPS an expiry on
-- those rows rather than refusing: they are given `created_at + 15 minutes`,
-- the TTL the old design used, which for any code older than that means it
-- reads as expired.
--
-- That is a real consequence and it is the honest one: rolling back to a design
-- where codes expire cannot preserve codes that were never meant to. Every
-- affected student re-issues. The alternative — a far-future timestamp — would
-- leave codes that the restored code path believes are live forever, which is
-- the old design with none of its safety.
-- ===========================================================================

DROP INDEX IF EXISTS "link_code_otp_expires_at_idx";
DROP INDEX IF EXISTS "link_code_otp_one_per_parent_code";
DROP TABLE IF EXISTS "link_code_otp_challenges";

UPDATE "link_codes"
   SET "expires_at" = "created_at" + interval '15 minutes'
 WHERE "expires_at" IS NULL;

ALTER TABLE "link_codes" ALTER COLUMN "expires_at" SET NOT NULL;
