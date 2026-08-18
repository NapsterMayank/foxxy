-- Guardian linking, rebuilt to match the shape already proven in production.
--
-- ===========================================================================
-- WHAT CHANGES, AND WHY IT IS NOT A REFINEMENT OF THE OLD DESIGN BUT A
-- REPLACEMENT OF ITS CONSENT MODEL.
--
-- The previous flow was: student issues a 15-minute code, parent submits it,
-- the link sits `pending`, and THE STUDENT APPROVES. That model had a defect
-- that only surfaced when the flow was exercised end to end — there is no
-- endpoint through which a student can discover a pending link's id, so the
-- approval step was unreachable and every parent stayed `pending` forever.
--
-- The working product solves it differently and better: the code hand-off IS
-- the consent (a student reads their code to their parent — a deliberate act),
-- and the second factor protects the PARENT'S account rather than asking the
-- student twice. An OTP goes to the parent's own verified address, so entering
-- a code you overheard is not enough; you must also control that mailbox.
--
-- Two consequences, both deliberate:
--   1. `link_codes.expires_at` becomes NULLABLE. A code that expires in
--      fifteen minutes requires the parent to be standing next to the child
--      while it is generated. NULL means "does not expire", which is what a
--      code printed on a school slip needs to be.
--   2. A redeemed link is `approved` on insert. There is no `pending` state in
--      the new path — see `link_code_otp_challenges` for what replaces it.
-- ===========================================================================

-- 1. Persistent codes. NULL = never expires; a value still expires, so the
--    old rows and the old tests keep their meaning.
ALTER TABLE "link_codes" ALTER COLUMN "expires_at" DROP NOT NULL;

-- 2. The OTP challenge.
--
-- ONE ROW PER (parent, code) — see the unique index. A resend UPDATES it rather
-- than inserting a second, so the attempt counter and the lock cannot be reset
-- by asking for a fresh code.
CREATE TABLE IF NOT EXISTS "link_code_otp_challenges" (
  "id" uuid PRIMARY KEY,
  "parent_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "student_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  -- The code as submitted, upper-cased. Kept so a resend can find the row
  -- without re-resolving the student.
  "code" text NOT NULL,
  -- sha256(otp || id). THE OTP ITSELF IS NEVER STORED: a six-digit secret in a
  -- leaked table is a million guesses, which is no guesses at all. The row id
  -- is mixed in so two challenges that happen to draw the same OTP do not
  -- produce the same digest.
  "otp_hash" text NOT NULL,
  -- Wrong guesses. At the cap the row is LOCKED, not deleted — deleting it
  -- would let the next request start a fresh budget.
  "attempts" integer NOT NULL DEFAULT 0,
  "locked_until" timestamptz,
  -- Resend cooldown. Every send costs an email to a real person's inbox.
  "last_sent_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- The constraint that makes the attempt counter meaningful.
CREATE UNIQUE INDEX IF NOT EXISTS "link_code_otp_one_per_parent_code"
  ON "link_code_otp_challenges" ("parent_user_id", "code");

-- For the sweeper.
CREATE INDEX IF NOT EXISTS "link_code_otp_expires_at_idx"
  ON "link_code_otp_challenges" ("expires_at");
