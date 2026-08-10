CREATE TABLE "chapter_concepts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chapter_id" uuid NOT NULL,
	"concept_number" integer,
	"slug" text,
	"title_en" text NOT NULL,
	"title_hi" text,
	"learning_objective" text,
	"explanation_en" text,
	"explanation_hi" text,
	"example_content" text,
	"key_formula" text,
	"common_mistakes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "concept_graph" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chapter_id" uuid NOT NULL,
	"concept_code" text NOT NULL,
	"concept_name" text,
	"prerequisite_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"bloom_level" text,
	"cognitive_load" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "misconception_patterns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_code" text NOT NULL,
	"concept_code" text,
	"pattern_code" text NOT NULL,
	"description" text,
	"detection_rule" jsonb,
	"remediation_strategy" text,
	"remediation_concept_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"severity" integer,
	"is_orphan" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chapter_concepts" ADD CONSTRAINT "chapter_concepts_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_graph" ADD CONSTRAINT "concept_graph_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chapter_concepts_chapter_idx" ON "chapter_concepts" USING btree ("chapter_id","concept_number");--> statement-breakpoint
CREATE UNIQUE INDEX "concept_graph_concept_code_unique" ON "concept_graph" USING btree ("concept_code");--> statement-breakpoint
CREATE INDEX "concept_graph_chapter_idx" ON "concept_graph" USING btree ("chapter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "misconception_patterns_pattern_code_unique" ON "misconception_patterns" USING btree ("pattern_code");--> statement-breakpoint
CREATE INDEX "misconception_patterns_subject_idx" ON "misconception_patterns" USING btree ("subject_code");