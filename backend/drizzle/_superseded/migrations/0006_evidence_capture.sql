-- 0006_evidence_capture — five columns on `question_responses` that cannot be
-- backfilled.
--
-- Hand-written, then checked against the drizzle schema (plan §4, rule 1).
--
-- ===========================================================================
-- THE ONLY ITEM ON 05-ROADMAP.md §8 WHOSE "COST LATER" IS NOT A NUMBER.
--
-- Every other hook on that table costs days if it is skipped. This row says
-- "Unrecoverable. History cannot be backfilled", and §3 spells out the
-- consequence: the Phase 1 teacher screen and the Phase 4 principal dashboard
-- run on this data, and "if the MVP does not record these, the teacher screen
-- launches empty and stays empty for months."
--
-- The asymmetry is the whole argument. A student who practised in September and
-- changed four answers with two hints leaves no trace of either unless the
-- columns existed in September. No query, no export, no vendor and no amount of
-- money recovers it afterwards. Adding five nullable columns to an empty table
-- costs one migration.
--
-- NOTHING WRITES THESE YET. `practice` is build step 11. That is not a reason
-- to wait — it is the reason to do it now, because the table is empty and every
-- one of these is a metadata-only ALTER.
--
-- ===========================================================================
-- WHY EVERY COLUMN CARRIES A COMMENT ON COLUMN.
--
-- Because none of this is inferable later. `hint_level_used` reads like a
-- setting; `first_selected_index` reads like a duplicate of `selected_index`;
-- `confidence` reads like a model output. The person who eventually writes the
-- teacher screen is not the person writing this file, and the column names
-- alone will actively mislead them. A `\d+ question_responses` at a psql prompt
-- has to be enough.
--
-- ===========================================================================
-- A NOTE ON THIS TABLE'S NAME, so the next reader is not confused.
--
-- D-057 decides that `question_responses` and the not-yet-built
-- `practice_responses` merge into ONE table called `practice_responses`, and
-- that the merge happens when `practice` is built (step 11). It has not
-- happened: `question_responses` is the only response log that exists on disk
-- today, and it is the one these columns belong to.
--
-- The merge, when it comes, is a RENAME plus the addition of `session_id`. That
-- carries these five columns with it for free. Adding them to a table that does
-- not exist yet would not have been possible; waiting for the rename would have
-- meant waiting eight build steps, which is exactly the delay this hook exists
-- to prevent.

-- ---------------------------------------------------------------------------
-- first_selected_index — the answer BEFORE any change of mind.
--
-- Not derivable from `selected_index`, which is the final answer. A student who
-- selects the misconception distractor and then corrects themselves has
-- demonstrated the misconception AND the recovery, and only the first half is
-- diagnostic. Without this, that student is indistinguishable from one who was
-- right immediately — and those two need opposite interventions.
--
-- CANONICAL, NOT SHUFFLED, exactly like `selected_index` (D-058). Practice
-- shuffles options for presentation and translates back before storing, because
-- misconception codes are keyed by ORIGINAL option index (D-048). A shuffled
-- value here would mislabel every misconception silently.
ALTER TABLE "question_responses" ADD COLUMN IF NOT EXISTS "first_selected_index" integer;--> statement-breakpoint
ALTER TABLE "question_responses" ADD CONSTRAINT "question_responses_first_selected_index_check" CHECK ("question_responses"."first_selected_index" is null or ("question_responses"."first_selected_index" >= 0 and "question_responses"."first_selected_index" < 4));--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- answer_changed — whether the answer changed at all.
--
-- Redundant with `first_selected_index <> selected_index` when the first index
-- is known, and the CHECK below enforces that the two agree so they can never
-- tell different stories. It exists separately because "did this student waver"
-- is answerable even where the interface recorded the fact but not the value,
-- and because it is the column a teacher screen actually filters on — an index
-- on a boolean is cheap; a derived comparison across two nullable integers is
-- not.
ALTER TABLE "question_responses" ADD COLUMN IF NOT EXISTS "answer_changed" boolean;--> statement-breakpoint
-- Storing a derivable fact beside the thing it derives from is how two columns
-- start disagreeing, and the disagreement would be invisible because both
-- values are individually plausible. Where both are present, the database
-- settles it.
ALTER TABLE "question_responses" ADD CONSTRAINT "question_responses_answer_changed_check" CHECK ("question_responses"."first_selected_index" is null or "question_responses"."answer_changed" is null or "question_responses"."answer_changed" = ("question_responses"."first_selected_index" <> "question_responses"."selected_index"));--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- hint_level_used — 0 MEANS NONE, and 0 is a real observation.
--
-- The only one of the five that is NOT NULL, and the reason is that "no hints"
-- is a statement rather than an absence: a response recorded without hint
-- tracking and a response where the student used no hints are the same thing
-- for every purpose this column serves.
--
-- The question bank carries three hint levels. A correct answer at hint level 3
-- and a correct answer at hint level 0 are the same row without this column,
-- and they are not the same evidence.
ALTER TABLE "question_responses" ADD COLUMN IF NOT EXISTS "hint_level_used" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "question_responses" ADD CONSTRAINT "question_responses_hint_level_check" CHECK ("question_responses"."hint_level_used" >= 0);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- confidence — what the student said about themselves BEFORE answering.
--
-- The single most valuable signal on this table and the most obviously
-- impossible to reconstruct. Confident-and-wrong is a misconception;
-- unsure-and-right is a guess. Both are identical in `is_correct`, and they
-- call for opposite interventions.
--
-- A small closed set with a CHECK rather than free text: it is a DECISION
-- column — remediation branches on it — so an unexpected value would change
-- what a student is shown. Contrast `explanation_format_used` below.
--
-- Nullable, because it is only present where the interface asked. Inventing a
-- value for the rest would put a number on a teacher's screen that nobody said.
ALTER TABLE "question_responses" ADD COLUMN IF NOT EXISTS "confidence" text;--> statement-breakpoint
ALTER TABLE "question_responses" ADD CONSTRAINT "question_responses_confidence_check" CHECK ("question_responses"."confidence" is null or "question_responses"."confidence" in ('unsure', 'unsure_ish', 'confident'));--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- explanation_format_used — which explanation style the student chose.
--
-- DELIBERATELY UNCONSTRAINED TEXT, and the contrast with `confidence` directly
-- above is the whole reasoning. The set of formats ('text', 'worked_example',
-- 'analogy', 'video', ...) is a product experiment that will change several
-- times, and a CHECK would make each change a migration on a large table.
--
-- It is an ANALYTICS column, not a decision column: nothing branches on it, so
-- an unexpected value costs a line in a report rather than a wrong answer. That
-- is the test for whether a closed set is worth a constraint.
ALTER TABLE "question_responses" ADD COLUMN IF NOT EXISTS "explanation_format_used" text;--> statement-breakpoint

COMMENT ON COLUMN "question_responses"."first_selected_index" IS
	'The option index chosen FIRST, before any change of mind. CANONICAL (unshuffled) index, exactly like selected_index - see D-058 and D-048. Not derivable from selected_index: a student who picks the misconception distractor and then corrects it has shown both the misconception and the recovery, and only the first is diagnostic. NULL where the interface did not record it. UNRECOVERABLE if not captured at the time.';--> statement-breakpoint
COMMENT ON COLUMN "question_responses"."answer_changed" IS
	'Whether the student changed their answer. A CHECK forces agreement with (first_selected_index <> selected_index) whenever both are present, so the two cannot tell different stories. Kept as its own column because it is answerable when only the fact was recorded, and because it is what a teacher screen filters on.';--> statement-breakpoint
COMMENT ON COLUMN "question_responses"."hint_level_used" IS
	'How many hint levels the student consumed. 0 MEANS NONE and is a real observation, which is why this column is NOT NULL while its neighbours are nullable. Correct-at-hint-3 and correct-at-hint-0 are indistinguishable without it, and they are not the same evidence.';--> statement-breakpoint
COMMENT ON COLUMN "question_responses"."confidence" IS
	'Self-reported confidence BEFORE answering: unsure | unsure_ish | confident. Confident-and-wrong is a misconception; unsure-and-right is a guess - identical in is_correct, opposite interventions. A CHECKed closed set because remediation BRANCHES on it. NULL where the interface did not ask. UNRECOVERABLE if not captured at the time.';--> statement-breakpoint
COMMENT ON COLUMN "question_responses"."explanation_format_used" IS
	'Which explanation style the student chose to read afterwards (text | worked_example | analogy | video | ...). Deliberately UNCONSTRAINED text: the set is a product experiment that will change, and this is an analytics column that nothing branches on, so an unexpected value costs a report line rather than a wrong answer. Contrast confidence, which is CHECKed because it is a decision column.';
