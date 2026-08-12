-- 0000_baseline — THE COLLAPSED BASELINE (D-091, superseding D-081).
--
-- ===========================================================================
-- WHAT THIS FILE IS.
--
-- Migrations 0000-0008 were collapsed into this single file plus a single
-- matching snapshot. The superseded originals are kept, unmodified and
-- excluded from the runner, in `drizzle/_superseded/`.
--
-- WHY, in one sentence: 0004-0007 were hand-written, so per-migration
-- snapshots for them never existed and could not be reconstructed (D-081), and
-- a chain with holes in it is a chain whose generator you have to reason about
-- rather than trust. Nothing is deployed anywhere and the repository has no
-- commits, so collapsing costs nothing today and gets strictly more expensive
-- every day after.
--
-- ===========================================================================
-- EQUIVALENCE IS PROVEN BY DIFF, NOT ASSERTED.
--
-- `tests/integration/baseline-collapse.test.ts` applies the superseded chain to
-- one database and this file to another, dumps both schemas out of the
-- catalogue — tables, columns, defaults, every constraint's expression,
-- indexes, foreign keys, triggers, functions, comments and the seeded tenant
-- row — and asserts the two dumps are equal. If a future edit to this file
-- drifts from the chain it replaces, that test says so and names the object.
--
-- The superseded chain is therefore NOT dead weight: it is the oracle.
--
-- ===========================================================================
-- HOW THIS FILE WAS BUILT, so it can be rebuilt the same way.
--
--   1. drizzle-kit generate, against an empty out-directory, emitted the whole
--      CREATE TABLE / CREATE INDEX / ADD CONSTRAINT body from the TypeScript
--      schema. Its snapshot was compared field-by-field against the old
--      0008_snapshot and found IDENTICAL apart from `id`/`prevId` — which is
--      the independent confirmation that the schema and the old chain had not
--      drifted apart before the collapse.
--   2. Everything drizzle-kit cannot emit was appended: the two extensions,
--      the default tenant row, the audit_log append-only trigger, and every
--      COMMENT. The comment text was read back out of the database the OLD
--      chain produced rather than copied by hand, so no character of it was
--      retyped.
--
-- Statements that were `ALTER TABLE ... SET NOT NULL` in the chain are simply
-- NOT NULL in the CREATE TABLE here, and the 0008 backfill UPDATEs are absent
-- because there is nothing to backfill in a database this file has just
-- created. That is the only class of difference between the two, and it is a
-- difference in path, not in destination — which is what the diff checks.
-- ===========================================================================

-- Extensions must exist before any column uses their types.
-- `citext` : users.email is case-insensitive at the column level.
-- `vector` : pgvector, for rag_chunks.embedding.
-- drizzle-kit does not emit extension DDL, so these are hand-carried.
CREATE EXTENSION IF NOT EXISTS "citext";
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "vector";--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_check" CHECK ("tenants"."slug" ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
	CONSTRAINT "tenants_name_check" CHECK (length(btrim("tenants"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "email_verification_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "link_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_user_id" uuid NOT NULL,
	"code" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parent_child_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_user_id" uuid NOT NULL,
	"student_user_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"tenant_id" uuid DEFAULT '11111111-1111-4111-8111-111111111111' NOT NULL,
	"link_code" text,
	"approved_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parent_child_links_status_check" CHECK ("parent_child_links"."status" in ('pending', 'approved', 'revoked')),
	CONSTRAINT "parent_child_links_distinct_check" CHECK ("parent_child_links"."parent_user_id" <> "parent_child_links"."student_user_id")
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	"ip_hash" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"password_hash" text NOT NULL,
	"role" text NOT NULL,
	"tenant_id" uuid DEFAULT '11111111-1111-4111-8111-111111111111' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_role_check" CHECK ("users"."role" in ('student', 'parent', 'teacher', 'principal', 'content_author', 'academic_reviewer', 'implementation_manager', 'support_agent', 'school_success', 'super_admin'))
);
--> statement-breakpoint
CREATE TABLE "chapter_mastery" (
	"student_user_id" uuid NOT NULL,
	"chapter_id" uuid NOT NULL,
	"mastery_score" numeric(4, 3) DEFAULT '0' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_practised_at" timestamp with time zone,
	"tenant_id" uuid DEFAULT '11111111-1111-4111-8111-111111111111' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chapter_mastery_pkey" PRIMARY KEY("student_user_id","chapter_id"),
	CONSTRAINT "chapter_mastery_score_check" CHECK ("chapter_mastery"."mastery_score" >= 0 and "chapter_mastery"."mastery_score" <= 1),
	CONSTRAINT "chapter_mastery_attempts_check" CHECK ("chapter_mastery"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "student_subjects" (
	"student_user_id" uuid NOT NULL,
	"subject_code" text NOT NULL,
	"tenant_id" uuid DEFAULT '11111111-1111-4111-8111-111111111111' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_subjects_pkey" PRIMARY KEY("student_user_id","subject_code"),
	CONSTRAINT "student_subjects_subject_code_check" CHECK (length(btrim("student_subjects"."subject_code")) > 0)
);
--> statement-breakpoint
CREATE TABLE "students" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"grade" text NOT NULL,
	"board" text DEFAULT 'CBSE' NOT NULL,
	"preferred_language" text DEFAULT 'en' NOT NULL,
	"tenant_id" uuid DEFAULT '11111111-1111-4111-8111-111111111111' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "students_grade_check" CHECK ("students"."grade" in ('6', '7', '8', '9', '10', '11', '12')),
	CONSTRAINT "students_preferred_language_check" CHECK ("students"."preferred_language" in ('en', 'hi')),
	CONSTRAINT "students_display_name_check" CHECK (length(btrim("students"."display_name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "chapters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grade" text NOT NULL,
	"subject_code" text NOT NULL,
	"chapter_number" integer NOT NULL,
	"title_en" text NOT NULL,
	"title_hi" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chapters_grade_check" CHECK ("chapters"."grade" in ('6', '7', '8', '9', '10', '11', '12')),
	CONSTRAINT "chapters_chapter_number_check" CHECK ("chapters"."chapter_number" > 0),
	CONSTRAINT "chapters_title_en_check" CHECK (length(btrim("chapters"."title_en")) > 0)
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chapter_id" uuid NOT NULL,
	"question_text" text NOT NULL,
	"options" jsonb NOT NULL,
	"correct_index" integer NOT NULL,
	"explanation" text NOT NULL,
	"difficulty" text NOT NULL,
	"bloom_level" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"distractor_misconceptions" jsonb,
	"is_held_out" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "questions_options_check" CHECK (case when jsonb_typeof("questions"."options") = 'array'
                then jsonb_array_length("questions"."options") = 4
                 and jsonb_array_length("questions"."options" - '') = 4
                else false
           end),
	CONSTRAINT "questions_correct_index_check" CHECK ("questions"."correct_index" >= 0 and "questions"."correct_index" < 4),
	CONSTRAINT "questions_question_text_check" CHECK (length(btrim("questions"."question_text")) > 0),
	CONSTRAINT "questions_explanation_check" CHECK (length(btrim("questions"."explanation")) > 0),
	CONSTRAINT "questions_difficulty_check" CHECK ("questions"."difficulty" in ('easy', 'medium', 'hard')),
	CONSTRAINT "questions_bloom_level_check" CHECK ("questions"."bloom_level" in ('remember', 'understand', 'apply', 'analyse', 'evaluate', 'create')),
	CONSTRAINT "questions_distractor_misconceptions_check" CHECK (case
            when "questions"."distractor_misconceptions" is null then true
            when jsonb_typeof("questions"."distractor_misconceptions") <> 'object' then false
            else jsonb_array_length(
                   jsonb_path_query_array("questions"."distractor_misconceptions", '$.keyvalue()')
                 ) = 3
                 and "questions"."distractor_misconceptions" - array['0', '1', '2', '3'] = '{}'::jsonb
                 and not ("questions"."distractor_misconceptions" ? ("questions"."correct_index")::text)
          end)
);
--> statement-breakpoint
CREATE TABLE "rag_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chapter_id" uuid,
	"chunk_text" text NOT NULL,
	"chunk_index" integer DEFAULT 0 NOT NULL,
	"chunk_type" text DEFAULT 'paragraph' NOT NULL,
	"board" text DEFAULT 'CBSE' NOT NULL,
	"grade" text NOT NULL,
	"subject" text NOT NULL,
	"chapter_number" integer,
	"chapter_title" text,
	"topic" text,
	"concept" text,
	"difficulty_level" integer DEFAULT 2,
	"content_layer" text DEFAULT 'foundation',
	"language" text DEFAULT 'en',
	"embedding" vector(1024),
	"embedding_model" text,
	"embedded_at" timestamp with time zone,
	"word_count" integer,
	"token_count" integer,
	"quality_score" double precision,
	"is_active" boolean DEFAULT true NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (case when language = 'hi'
            then setweight(to_tsvector('simple', coalesce(chapter_title, '') || ' ' || coalesce(topic, '') || ' ' || coalesce(concept, '')), 'A')
              || setweight(to_tsvector('simple', coalesce(chunk_text, '')), 'B')
            else setweight(to_tsvector('english', coalesce(chapter_title, '') || ' ' || coalesce(topic, '') || ' ' || coalesce(concept, '')), 'A')
              || setweight(to_tsvector('english', coalesce(chunk_text, '')), 'B')
          end) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rag_chunks_grade_check" CHECK ("rag_chunks"."grade" in ('6', '7', '8', '9', '10', '11', '12')),
	CONSTRAINT "rag_chunks_chunk_text_check" CHECK (length(btrim("rag_chunks"."chunk_text")) > 0),
	CONSTRAINT "rag_chunks_chunk_index_check" CHECK ("rag_chunks"."chunk_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "question_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_user_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"selected_index" integer NOT NULL,
	"is_correct" boolean NOT NULL,
	"time_spent_ms" integer NOT NULL,
	"authored_difficulty" text NOT NULL,
	"first_selected_index" integer,
	"answer_changed" boolean,
	"hint_level_used" integer DEFAULT 0 NOT NULL,
	"confidence" text,
	"explanation_format_used" text,
	"tenant_id" uuid DEFAULT '11111111-1111-4111-8111-111111111111' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_responses_selected_index_check" CHECK ("question_responses"."selected_index" >= 0 and "question_responses"."selected_index" < 4),
	CONSTRAINT "question_responses_time_spent_check" CHECK ("question_responses"."time_spent_ms" >= 0),
	CONSTRAINT "question_responses_authored_difficulty_check" CHECK ("question_responses"."authored_difficulty" in ('easy', 'medium', 'hard')),
	CONSTRAINT "question_responses_first_selected_index_check" CHECK ("question_responses"."first_selected_index" is null
          or ("question_responses"."first_selected_index" >= 0
              and "question_responses"."first_selected_index" < 4)),
	CONSTRAINT "question_responses_answer_changed_check" CHECK ("question_responses"."first_selected_index" is null
          or "question_responses"."answer_changed" is null
          or "question_responses"."answer_changed" = ("question_responses"."first_selected_index" <> "question_responses"."selected_index")),
	CONSTRAINT "question_responses_hint_level_check" CHECK ("question_responses"."hint_level_used" >= 0),
	CONSTRAINT "question_responses_confidence_check" CHECK ("question_responses"."confidence" is null or "question_responses"."confidence" in ('unsure', 'unsure_ish', 'confident'))
);
--> statement-breakpoint
CREATE TABLE "class_enrolments" (
	"class_id" uuid NOT NULL,
	"student_user_id" uuid NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "class_enrolments_pkey" PRIMARY KEY("class_id","student_user_id")
);
--> statement-breakpoint
CREATE TABLE "classes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"grade" text NOT NULL,
	"section" text NOT NULL,
	"academic_year" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "classes_grade_check" CHECK ("classes"."grade" in ('6', '7', '8', '9', '10', '11', '12')),
	CONSTRAINT "classes_section_check" CHECK (length(btrim("classes"."section")) > 0),
	CONSTRAINT "classes_academic_year_check" CHECK ("classes"."academic_year" ~ '^[0-9]{4}-[0-9]{2}$')
);
--> statement-breakpoint
CREATE TABLE "schools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"board" text DEFAULT 'CBSE' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schools_name_check" CHECK (length(btrim("schools"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"actor_role" text,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"tenant_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_action_check" CHECK (length(btrim("audit_log"."action")) > 0),
	CONSTRAINT "audit_log_resource_type_check" CHECK (length(btrim("audit_log"."resource_type")) > 0),
	CONSTRAINT "audit_log_metadata_object_check" CHECK (jsonb_typeof("audit_log"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"tenant_id" uuid,
	"kind" text NOT NULL,
	"title_en" text NOT NULL,
	"body_en" text NOT NULL,
	"title_hi" text NOT NULL,
	"body_hi" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_kind_check" CHECK (length(btrim("notifications"."kind")) > 0),
	CONSTRAINT "notifications_bilingual_check" CHECK (length(btrim("notifications"."title_en")) > 0
          and length(btrim("notifications"."body_en")) > 0
          and length(btrim("notifications"."title_hi")) > 0
          and length(btrim("notifications"."body_hi")) > 0),
	CONSTRAINT "notifications_data_object_check" CHECK (jsonb_typeof("notifications"."data") = 'object')
);
--> statement-breakpoint
CREATE TABLE "metrics_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"value" double precision NOT NULL,
	"tags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metrics_events_kind_check" CHECK ("metrics_events"."kind" in ('counter', 'gauge', 'histogram')),
	CONSTRAINT "metrics_events_name_check" CHECK (length(btrim("metrics_events"."name")) > 0),
	CONSTRAINT "metrics_events_tags_object_check" CHECK (jsonb_typeof("metrics_events"."tags") = 'object')
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_beat_at" timestamp with time zone NOT NULL,
	"jobs_processed" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	CONSTRAINT "worker_heartbeats_status_check" CHECK ("worker_heartbeats"."status" in ('running', 'draining', 'stopped')),
	CONSTRAINT "worker_heartbeats_jobs_processed_check" CHECK ("worker_heartbeats"."jobs_processed" >= 0)
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_status_check" CHECK ("jobs"."status" in ('pending', 'running', 'succeeded', 'failed', 'dead')),
	CONSTRAINT "jobs_kind_check" CHECK (length(btrim("jobs"."kind")) > 0),
	CONSTRAINT "jobs_idempotency_key_check" CHECK (length(btrim("jobs"."idempotency_key")) > 0),
	CONSTRAINT "jobs_attempts_check" CHECK ("jobs"."attempts" >= 0),
	CONSTRAINT "jobs_max_attempts_check" CHECK ("jobs"."max_attempts" >= 1),
	CONSTRAINT "jobs_payload_object_check" CHECK (jsonb_typeof("jobs"."payload") = 'object')
);
--> statement-breakpoint
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_codes" ADD CONSTRAINT "link_codes_student_user_id_users_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_child_links" ADD CONSTRAINT "parent_child_links_parent_user_id_users_id_fk" FOREIGN KEY ("parent_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_child_links" ADD CONSTRAINT "parent_child_links_student_user_id_users_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_child_links" ADD CONSTRAINT "parent_child_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapter_mastery" ADD CONSTRAINT "chapter_mastery_student_user_id_students_user_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."students"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapter_mastery" ADD CONSTRAINT "chapter_mastery_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapter_mastery" ADD CONSTRAINT "chapter_mastery_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_subjects" ADD CONSTRAINT "student_subjects_student_user_id_students_user_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."students"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_subjects" ADD CONSTRAINT "student_subjects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_chunks" ADD CONSTRAINT "rag_chunks_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_responses" ADD CONSTRAINT "question_responses_student_user_id_students_user_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."students"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_responses" ADD CONSTRAINT "question_responses_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_responses" ADD CONSTRAINT "question_responses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_enrolments" ADD CONSTRAINT "class_enrolments_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_enrolments" ADD CONSTRAINT "class_enrolments_student_user_id_users_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schools" ADD CONSTRAINT "schools_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_unique" ON "tenants" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "email_verification_tokens_token_hash_unique" ON "email_verification_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "email_verification_tokens_user_id_idx" ON "email_verification_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "link_codes_code_unique" ON "link_codes" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "link_codes_one_active_per_student" ON "link_codes" USING btree ("student_user_id") WHERE consumed_at is null;--> statement-breakpoint
CREATE INDEX "link_codes_expires_at_idx" ON "link_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "parent_child_links_parent_student_unique" ON "parent_child_links" USING btree ("parent_user_id","student_user_id");--> statement-breakpoint
CREATE INDEX "parent_child_links_parent_idx" ON "parent_child_links" USING btree ("parent_user_id");--> statement-breakpoint
CREATE INDEX "parent_child_links_student_idx" ON "parent_child_links" USING btree ("student_user_id");--> statement-breakpoint
CREATE INDEX "parent_child_links_tenant_idx" ON "parent_child_links" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_unique" ON "password_reset_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_unique" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_tenant_idx" ON "users" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "chapter_mastery_chapter_idx" ON "chapter_mastery" USING btree ("chapter_id");--> statement-breakpoint
CREATE INDEX "chapter_mastery_tenant_idx" ON "chapter_mastery" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "student_subjects_tenant_idx" ON "student_subjects" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "students_tenant_idx" ON "students" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chapters_grade_subject_number_unique" ON "chapters" USING btree ("grade","subject_code","chapter_number");--> statement-breakpoint
CREATE INDEX "questions_chapter_active_held_out_idx" ON "questions" USING btree ("chapter_id","is_active","is_held_out");--> statement-breakpoint
CREATE INDEX "rag_chunks_embedding_hnsw" ON "rag_chunks" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=128);--> statement-breakpoint
CREATE INDEX "rag_chunks_search_vector_gin" ON "rag_chunks" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "rag_chunks_grade_subject_idx" ON "rag_chunks" USING btree ("grade","subject") WHERE is_active;--> statement-breakpoint
CREATE INDEX "rag_chunks_chapter_idx" ON "rag_chunks" USING btree ("chapter_id");--> statement-breakpoint
CREATE INDEX "question_responses_tenant_idx" ON "question_responses" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "question_responses_question_idx" ON "question_responses" USING btree ("question_id","created_at");--> statement-breakpoint
CREATE INDEX "question_responses_student_idx" ON "question_responses" USING btree ("student_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "class_enrolments_student_idx" ON "class_enrolments" USING btree ("student_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "classes_school_grade_section_year_unique" ON "classes" USING btree ("school_id","grade","section","academic_year");--> statement-breakpoint
CREATE INDEX "schools_tenant_idx" ON "schools" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_created_idx" ON "audit_log" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_actor_created_idx" ON "audit_log" USING btree ("actor_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_resource_idx" ON "audit_log" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "notifications_recipient_created_idx" ON "notifications" USING btree ("recipient_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("recipient_user_id") WHERE read_at is null;--> statement-breakpoint
CREATE INDEX "metrics_events_name_recorded_idx" ON "metrics_events" USING btree ("name","recorded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "metrics_events_recorded_idx" ON "metrics_events" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "worker_heartbeats_last_beat_idx" ON "worker_heartbeats" USING btree ("last_beat_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_kind_idempotency_key_unique" ON "jobs" USING btree ("kind","idempotency_key");--> statement-breakpoint
CREATE INDEX "jobs_claimable_idx" ON "jobs" USING btree ("run_at","kind") WHERE status in ('pending', 'failed');--> statement-breakpoint
CREATE INDEX "jobs_locked_at_idx" ON "jobs" USING btree ("locked_at") WHERE status = 'running';--> statement-breakpoint
-- ===========================================================================
-- THE ONE TENANT THAT EXISTS.
--
-- A FIXED id rather than a generated one, written identically here, in
-- `schema/tenants.ts` as `DEFAULT_TENANT_ID`, and in the tests. Three copies of
-- a literal is normally a smell; here it is the point. The alternative is a
-- runtime "find the default tenant, or create it", which turns a broken
-- database into a silently self-healing one — and a system that invents a
-- tenant when it cannot find the right one is a system that will one day file a
-- school's children under a tenant it made up.
--
-- ON CONFLICT DO NOTHING so the migration is safe to re-apply.
INSERT INTO "tenants" ("id", "slug", "name")
VALUES ('11111111-1111-4111-8111-111111111111', 'default', 'Default tenant')
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
-- ===========================================================================
-- audit_log IS APPEND-ONLY BY TRIGGER, NOT BY CONVENTION (D-063).
--
-- SECURITY INVOKER (the default) and no search_path games: it does nothing but
-- raise, so there is nothing for a hostile search_path to redirect. It raises
-- with SQLSTATE 2F004 rather than a bare exception, so a caller can distinguish
-- it from a constraint violation.
--
-- TRUNCATE IS DELIBERATELY NOT BLOCKED. Row-level triggers do not fire on
-- TRUNCATE, and a statement-level trigger for it was considered and rejected:
-- TRUNCATE requires table OWNERSHIP, which the application role does not hold
-- in a real deployment, so it is already a DBA-only operation. It is also the
-- only mechanism left for retention and for resetting a test database now that
-- DELETE is refused. Blocking it would leave this table with no legal way to
-- ever shrink.
CREATE OR REPLACE FUNCTION "audit_log_reject_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP
		USING ERRCODE = '2F004',
		      HINT = 'Correct a mistaken audit entry by appending a compensating one. Retention is TRUNCATE, which is a DBA operation.';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "audit_log_no_update" ON "audit_log";
--> statement-breakpoint
CREATE TRIGGER "audit_log_no_update" BEFORE UPDATE ON "audit_log"
	FOR EACH ROW EXECUTE FUNCTION "audit_log_reject_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "audit_log_no_delete" ON "audit_log";
--> statement-breakpoint
CREATE TRIGGER "audit_log_no_delete" BEFORE DELETE ON "audit_log"
	FOR EACH ROW EXECUTE FUNCTION "audit_log_reject_mutation"();--> statement-breakpoint
COMMENT ON TABLE audit_log IS 'Append-only record of privileged actions. UPDATE and DELETE are refused by the audit_log_reject_mutation trigger; TRUNCATE is left available deliberately because it needs table ownership and is the only retention mechanism. NEVER CONTAINS PII - metadata is identifiers and counts, scrubbed through platform/pii by platform/audit before insert.';--> statement-breakpoint
COMMENT ON TABLE jobs IS 'The worker queue, claimed with FOR UPDATE SKIP LOCKED. AT-LEAST-ONCE delivery is assumed: a worker can finish the work and die before recording it, so handlers MUST be idempotent. A dead row is kept rather than deleted - a job that gave up silently is a job nobody investigates.';--> statement-breakpoint
COMMENT ON TABLE metrics_events IS 'The sink for platform/metrics. Deliberately a plain table, not a time-series store: the events are exceptional (breaker transitions, fallbacks, rejections, timeouts), not per-request. If a metric ever needs per-request granularity, write a second adapter - do not start writing a row per request here.';--> statement-breakpoint
COMMENT ON TABLE notifications IS 'Storage for the in-app notification channel (platform/notify-channel). Both languages are NOT NULL and non-empty: P7 enforced at the database as well as in the type system, because types do not survive a raw INSERT.';--> statement-breakpoint
COMMENT ON COLUMN audit_log.actor_user_id IS 'Deliberately NOT a foreign key. Any referential action (CASCADE deletes the trail, SET NULL is an UPDATE) collides with the append-only trigger and would make user deletion fail. Null for system actions - the worker has no user.';--> statement-breakpoint
COMMENT ON COLUMN audit_log.actor_role IS 'The role AT THE TIME of the action. Denormalised so that a later role change cannot rewrite history.';--> statement-breakpoint
COMMENT ON COLUMN audit_log.metadata IS 'Identifiers and counts ONLY. No email, no phone, no name, no free text from a user. Scrubbed by platform/audit before insert; a test drives an email and a phone number through record() and asserts neither lands here.';--> statement-breakpoint
COMMENT ON COLUMN jobs.idempotency_key IS 'Chosen by the caller and UNIQUE per kind. MUST be derived from what makes the work unique (e.g. parent id + ISO week), NEVER from a timestamp or a random value - either makes every enqueue a new job and defeats the mechanism entirely.';--> statement-breakpoint
COMMENT ON COLUMN jobs.last_error IS 'The failure MESSAGE only. Never a stack trace and never a payload dump: this column is read during incidents and must not become a place PII accumulates.';--> statement-breakpoint
COMMENT ON COLUMN metrics_events.tags IS 'Low-cardinality labels only. Never PII and never an identifier: it is simultaneously a privacy problem and a cardinality explosion. Scrubbed through platform/pii before insert.';--> statement-breakpoint
COMMENT ON COLUMN notifications.data IS 'Structured payload for the client to act on - identifiers and counts, never prose and never PII. Scrubbed through platform/pii on the way in, the same as audit_log.metadata.';--> statement-breakpoint
COMMENT ON COLUMN parent_child_links.tenant_id IS 'The tenant a parent-child link belongs to. NOT NULL since migration 0008. A link is the only cross-user data path in the product, so the identity module refuses to create one whose parent and student are in different tenants - the row can therefore only ever hold one tenant, and it is both parties.';--> statement-breakpoint
COMMENT ON COLUMN question_responses.authored_difficulty IS 'The difficulty the question carried WHEN IT WAS SERVED. Denormalised on purpose - joining questions.difficulty instead would let a later correction retroactively rewrite history, destroying the calibration this table exists for.';--> statement-breakpoint
COMMENT ON COLUMN question_responses.tenant_id IS 'Denormalised from students.tenant_id so cohort-level aggregates do not join. NOT NULL since migration 0008. A stale copy is a reporting bug; a forgotten join would be a data leak.';--> statement-breakpoint
COMMENT ON COLUMN question_responses.first_selected_index IS 'The option index chosen FIRST, before any change of mind. CANONICAL (unshuffled) index, exactly like selected_index - see D-058 and D-048. Not derivable from selected_index: a student who picks the misconception distractor and then corrects it has shown both the misconception and the recovery, and only the first is diagnostic. NULL where the interface did not record it. UNRECOVERABLE if not captured at the time.';--> statement-breakpoint
COMMENT ON COLUMN question_responses.answer_changed IS 'Whether the student changed their answer. A CHECK forces agreement with (first_selected_index <> selected_index) whenever both are present, so the two cannot tell different stories. Kept as its own column because it is answerable when only the fact was recorded, and because it is what a teacher screen filters on.';--> statement-breakpoint
COMMENT ON COLUMN question_responses.hint_level_used IS 'How many hint levels the student consumed. 0 MEANS NONE and is a real observation, which is why this column is NOT NULL while its neighbours are nullable. Correct-at-hint-3 and correct-at-hint-0 are indistinguishable without it, and they are not the same evidence.';--> statement-breakpoint
COMMENT ON COLUMN question_responses.confidence IS 'Self-reported confidence BEFORE answering: unsure | unsure_ish | confident. Confident-and-wrong is a misconception; unsure-and-right is a guess - identical in is_correct, opposite interventions. A CHECKed closed set because remediation BRANCHES on it. NULL where the interface did not ask. UNRECOVERABLE if not captured at the time.';--> statement-breakpoint
COMMENT ON COLUMN question_responses.explanation_format_used IS 'Which explanation style the student chose to read afterwards (text | worked_example | analogy | video | ...). Deliberately UNCONSTRAINED text: the set is a product experiment that will change, and this is an analytics column that nothing branches on, so an unexpected value costs a report line rather than a wrong answer. Contrast confidence, which is CHECKed because it is a decision column.';--> statement-breakpoint
COMMENT ON COLUMN questions.distractor_misconceptions IS 'Misconception codes as a jsonb OBJECT KEYED BY OPTION INDEX, e.g. {"0":"confuses_mass_weight","2":"unit_conversion_step","3":"sign_error_negative"}. Exactly 3 entries; every key in "0".."3"; the key equal to correct_index is ABSENT (a correct option has no misconception). Keyed rather than positional so that reordering options cannot silently re-label every code - see migration 0003 and D-048. NULL until authored.';--> statement-breakpoint
COMMENT ON COLUMN questions.is_held_out IS 'TRUE = reserved for independent mastery checks. MUST NEVER be served in practice: a question that has been practised may have been memorised and can no longer measure anything. Contamination is irreversible.';--> statement-breakpoint
COMMENT ON COLUMN rag_chunks.embedding IS 'voyage-3, 1024 dimensions. The width matches the existing corpus exactly, which is what makes the import a copy rather than a paid re-embedding run.';--> statement-breakpoint
COMMENT ON COLUMN rag_chunks.search_vector IS 'GENERATED ALWAYS ... STORED. Never write to it; the corpus import must NOT map the source column of the same name.';--> statement-breakpoint
COMMENT ON COLUMN students.tenant_id IS 'Which tenant this student belongs to. NOT NULL since migration 0008. Written from the authenticated actor on every insert path, never from client input.';--> statement-breakpoint
COMMENT ON COLUMN users.role IS 'One of PLATFORM_ROLES (shared/constants/roles.ts). The CHECK is wide so that adding a teacher in Phase 1 or a content author in Phase 4 is an INSERT rather than a locking migration on a live table. SELF-SERVICE SIGNUP ACCEPTS ONLY student AND parent - enforced by roleSchema, built from SIGNUP_ROLES, and pinned by a test. Do not point roleSchema at PLATFORM_ROLES.';--> statement-breakpoint
COMMENT ON COLUMN users.tenant_id IS 'Which tenant this ACCOUNT belongs to. NOT NULL since migration 0008 (D-073). This is the ACTOR side of the tenant comparison in platform/authz - assertCanAccess denies when it differs from the resource tenant, AND when either side is missing, before any allow rule is considered.';
