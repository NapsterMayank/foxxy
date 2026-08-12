-- 0005_foxy — the `foxy` module's schema (plan §4 "foxy", §8.5, build step 10).
--
-- THREE new tables: `chat_sessions`, `chat_messages`, `retrieval_traces`.
-- Nothing existing is altered, nothing is dropped, and no column changes type —
-- so this is safe to apply to the database holding the imported corpus, and its
-- rollback destroys only conversations that this migration made possible.
--
-- ===========================================================================
-- APPLYING THIS TURNS THE PARENT TRANSCRIPT ON. That is the one non-obvious
-- consequence, and it is worth stating before somebody applies it casually.
--
-- `parent.repository.readTranscript` probes `to_regclass('public.chat_sessions')`
-- and returns `source: 'not_yet_available'` while the table is absent. The
-- moment this lands the probe returns true and the parent transcript endpoint
-- starts serving real rows. It was written against plan §4's column names
-- before this file existed, so `chat_sessions(id, mode, started_at,
-- last_message_at, student_user_id, tenant_id)` and `chat_messages(id,
-- session_id, role, content, created_at)` with `role in ('user','assistant')`
-- are a CONTRACT, not a preference. Renaming any of them breaks a surface where
-- the failure is invisible: an empty transcript reads as a quiet child.
-- ===========================================================================
--
-- ===========================================================================
-- `chat_messages.seq` IS THE TRANSCRIPT ORDER, AND `created_at` IS NOT.
--
-- A question and its reply can share a millisecond — always, under the fixed
-- clock every test uses, and intermittently in production. Ordering by
-- `created_at` alone then returns the two turns in whatever order the plan
-- produced, so a transcript reads "assistant, user" at random and the history
-- handed to the model is incoherent. A `bigserial` is monotonic per insert and
-- needs no read-then-write, so two concurrent turns cannot share a number.
-- ===========================================================================
--
-- ===========================================================================
-- THE TWO CHECKS ON `chat_messages` ARE THE PRODUCT'S HARDEST CLAIMS.
--
--   `chat_messages_user_no_citations_check`
--       A student's own message can never carry citations and can never be an
--       abstention. Both are things the SYSTEM says.
--
--   `chat_messages_abstention_no_citations_check`
--       AN ABSTENTION CARRIES NO CITATIONS. "I could not find this in your
--       textbook" with a page reference attached is a contradiction, and it is
--       exactly the row a half-finished refactor writes — retrieval abstains,
--       the citation extractor runs anyway. The service is careful; this is
--       what makes carelessness impossible.
--
-- Both jsonb array checks use CASE rather than AND, because Postgres does not
-- guarantee AND evaluation order in a CHECK and `jsonb_array_length` on a
-- non-array raises a raw type error instead of naming the constraint (D-039).
-- ===========================================================================
--
-- `retrieval_traces` IS WRITTEN FOR EVERY TURN INCLUDING ABSTENTIONS, and it
-- carries the ASSEMBLED PROMPT verbatim. Plan §4: "the only way you will ever
-- debug a bad answer. Write it from the first day." The prompt column is the
-- one most likely to be dropped later as "big" — without it a bad answer can
-- only be reproduced by re-running today's assembler, which is a different
-- assembler from the one that produced the answer under investigation.
--
-- NO STUDENT IDENTIFIER on the trace. It is reachable FROM a message by
-- `message_id`, which plan §4 specifies and which is what ties an explanation
-- to the turn it explains; it holds no identifier of its own, so a query here
-- is a query about ANSWERS rather than a second copy of a child's activity log.
--
-- `tenant_id` IS NOT NULL WITH A DEFAULT on all three, matching every other
-- student-owned table (D-073). The service does not lean on the default: it
-- stamps the tenant `assertCanAccess` just passed on, so "filed under the
-- tenant that was checked" is true by construction rather than by habit.
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"session_id" uuid NOT NULL,
	"tenant_id" uuid DEFAULT '11111111-1111-4111-8111-111111111111' NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"action" text,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"abstained" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_messages_role_check" CHECK ("chat_messages"."role" in ('user', 'assistant')),
	CONSTRAINT "chat_messages_action_check" CHECK ("chat_messages"."action" is null or "chat_messages"."action" in ('simpler', 'visual', 'example', 'hindi', 'quiz_me', 'confused')),
	CONSTRAINT "chat_messages_content_check" CHECK (length(btrim("chat_messages"."content")) > 0),
	CONSTRAINT "chat_messages_citations_array_check" CHECK (case when jsonb_typeof("chat_messages"."citations") = 'array' then true else false end),
	CONSTRAINT "chat_messages_user_no_citations_check" CHECK ("chat_messages"."role" <> 'user' or ("chat_messages"."abstained" = false and jsonb_array_length("chat_messages"."citations") = 0)),
	CONSTRAINT "chat_messages_abstention_no_citations_check" CHECK ("chat_messages"."abstained" = false or jsonb_array_length("chat_messages"."citations") = 0)
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_user_id" uuid NOT NULL,
	"tenant_id" uuid DEFAULT '11111111-1111-4111-8111-111111111111' NOT NULL,
	"mode" text NOT NULL,
	"subject" text NOT NULL,
	"chapter_id" uuid,
	"language" text DEFAULT 'en' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone,
	CONSTRAINT "chat_sessions_mode_check" CHECK ("chat_sessions"."mode" in ('doubt', 'explain', 'practice')),
	CONSTRAINT "chat_sessions_subject_check" CHECK ("chat_sessions"."subject" in ('mathematics', 'science')),
	CONSTRAINT "chat_sessions_language_check" CHECK ("chat_sessions"."language" in ('en', 'hi'))
);
--> statement-breakpoint
CREATE TABLE "retrieval_traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"tenant_id" uuid DEFAULT '11111111-1111-4111-8111-111111111111' NOT NULL,
	"query" text NOT NULL,
	"rewritten_query" text NOT NULL,
	"grade" text NOT NULL,
	"subject" text NOT NULL,
	"retrieved" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fabricated_citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prompt" text NOT NULL,
	"answer" text DEFAULT '' NOT NULL,
	"abstained" boolean DEFAULT false NOT NULL,
	"abstain_reason" text,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retrieval_traces_grade_check" CHECK ("retrieval_traces"."grade" in ('6', '7', '8', '9', '10', '11', '12')),
	CONSTRAINT "retrieval_traces_tokens_check" CHECK ("retrieval_traces"."input_tokens" >= 0 and "retrieval_traces"."output_tokens" >= 0),
	CONSTRAINT "retrieval_traces_latency_check" CHECK ("retrieval_traces"."latency_ms" >= 0),
	CONSTRAINT "retrieval_traces_retrieved_array_check" CHECK (case when jsonb_typeof("retrieval_traces"."retrieved") = 'array' then true else false end),
	CONSTRAINT "retrieval_traces_citations_array_check" CHECK (case when jsonb_typeof("retrieval_traces"."citations") = 'array' then true else false end)
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_student_user_id_students_user_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."students"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_traces" ADD CONSTRAINT "retrieval_traces_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_traces" ADD CONSTRAINT "retrieval_traces_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_messages_session_idx" ON "chat_messages" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "chat_messages_tenant_idx" ON "chat_messages" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "chat_sessions_student_idx" ON "chat_sessions" USING btree ("student_user_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "chat_sessions_tenant_idx" ON "chat_sessions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "chat_sessions_chapter_idx" ON "chat_sessions" USING btree ("chapter_id");--> statement-breakpoint
CREATE INDEX "retrieval_traces_message_idx" ON "retrieval_traces" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "retrieval_traces_created_idx" ON "retrieval_traces" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "retrieval_traces_tenant_idx" ON "retrieval_traces" USING btree ("tenant_id");