-- Rollback for drizzle/migrations/0003_misconception_object.sql
--
-- Restores the positional-array CHECK and the alignment comment exactly as
-- migration 0002 left them, so 0002-then-0003-then-this is indistinguishable
-- from 0002 alone.
--
-- READ THIS BEFORE RUNNING IT AGAINST ANYTHING WITH DATA. The rollback is
-- SHAPE-BLIND: it restores a constraint that requires an ARRAY, so any row
-- holding the object shape this migration introduced will fail validation and
-- the ALTER will abort. That is the correct outcome — silently accepting both
-- shapes in one column is the ambiguity the whole change exists to remove —
-- but it means a rollback after authoring has begun requires converting the
-- rows back first, and the conversion LOSES the key information: an object
-- flattened to an array is aligned by convention again, and if the options
-- were reordered while the object shape was live, the resulting array is
-- wrong with nothing to detect it.
--
-- In short: this rollback is free only while `questions` is empty, which is
-- the same window in which the forward migration is free.

ALTER TABLE "questions" DROP CONSTRAINT "questions_distractor_misconceptions_check";--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_distractor_misconceptions_check" CHECK ("questions"."distractor_misconceptions" is null
          or case when jsonb_typeof("questions"."distractor_misconceptions") = 'array'
                  then jsonb_array_length("questions"."distractor_misconceptions") = 3
                  else false
             end);--> statement-breakpoint
COMMENT ON COLUMN "questions"."distractor_misconceptions" IS
  'Three misconception codes, one per WRONG option. ALIGNMENT: ordered by option index ASCENDING, SKIPPING correct_index. With correct_index=1, element 0 describes option 0, element 1 describes option 2, element 2 describes option 3. Getting this wrong mislabels every misconception silently. NULL until authored.';
