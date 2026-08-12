-- 0004_billing — the `billing` module's schema (plan §8.8, build step 13).
--
-- TWO new tables, `subscriptions` and `payment_events`. Nothing existing is
-- altered, nothing is dropped, and no column changes type — so this is safe to
-- apply to a populated database, and its rollback drops only tables that did
-- not exist before it.
--
-- ===========================================================================
-- THE PAYER IS A SEPARATE FACT FROM THE BENEFICIARY, AND THAT IS WHY THIS
-- MIGRATION LOOKS MORE COMPLICATED THAN A SUBSCRIPTION TABLE NEEDS TO.
--
-- It is unresolved whether the product ships B2C (a parent pays for their own
-- child) or as a B2B SCHOOL PILOT in which schools pay and per-parent
-- subscriptions never exist at all. A single `user_id` column would have
-- answered that question by accident, in the cheapest-looking way, and
-- unanswering it later is a migration across live financial rows.
--
-- So `subject_user_id` (whose entitlements this grants) and the payer
-- (`payer_kind` plus exactly one of `payer_user_id` / `payer_school_id`) are
-- independent, and `subscriptions_payer_exactly_one_check` makes any other
-- combination unrepresentable. The second half of that CHECK — that a school
-- payer must ALSO have a NULL user payer — is the one that matters: without it
-- a B2B row could carry a stale user payer, and a reconciliation query joining
-- on `payer_user_id` would bill the wrong party.
-- ===========================================================================
--
-- `payment_events_provider_event_key` IS THE ENTIRE REPLAY DEFENCE — §8.8 rule
-- 2. Not a "have I seen this?" SELECT before the write; two concurrent
-- deliveries both pass that, which is exactly what a provider retry storm
-- produces. The insert is attempted and the unique violation IS the duplicate
-- detection, so the check and the write are one statement with no window
-- between them. Rule 3 then requires the subscription UPDATE to happen in that
-- same transaction, which is a property of the service — but only because this
-- constraint makes it possible to write it that way.
--
-- `subscriptions_one_live_idx` IS PARTIAL, and has to be. A user accumulates
-- cancelled and expired rows over years, so a total unique constraint would
-- make re-subscribing impossible. What it prevents is the double-subscribe:
-- two checkout tabs, two `pending` rows, two charges, and an entitlement
-- resolver that has to guess which one is real.
--
-- `subscriptions_terminal_period_check` refuses a cancelled or expired row with
-- a NULL `current_period_end`. Access after cancellation runs until that
-- timestamp, so a NULL there is a subscription that grants access forever — the
-- failure being prevented is "cancelled in 2026, still entitled in 2031".
--
-- EVERY FOREIGN KEY OUT OF `subscriptions` IS `ON DELETE RESTRICT`, which is
-- deliberately unlike every other student-owned table in this schema. A
-- subscription is a FINANCIAL record: money moved, and a receipt that vanishes
-- because somebody deleted an account is a reconciliation hole and a GST-invoice
-- hole. Deleting a user who has ever been billed therefore FAILS LOUDLY. The
-- consequence is accepted and recorded: erasure for a paying user becomes an
-- ANONYMISE operation rather than a DELETE, and that work does not exist yet.
--
-- `payment_events.tenant_id` IS NULLABLE, unlike `subscriptions.tenant_id` —
-- the same reasoning as `audit_log` and `notifications` (open item 8, D-084).
-- The writer is an anonymous provider webhook with no actor and no session; the
-- only authoritative tenant is the SUBSCRIPTION the event matched, and an event
-- matching nothing genuinely has no tenant. Filling it from the column default
-- in that case would file cross-tenant noise under whichever tenant happens to
-- be first — a value that reads as a fact and is not one.
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"kind" text NOT NULL,
	"provider_event_name" text NOT NULL,
	"subscription_id" uuid,
	"payload" jsonb NOT NULL,
	"tenant_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_events_provider_event_key" UNIQUE("provider","provider_event_id"),
	CONSTRAINT "payment_events_kind_check" CHECK (length(btrim("payment_events"."kind")) > 0),
	CONSTRAINT "payment_events_payload_object_check" CHECK (jsonb_typeof("payment_events"."payload") = 'object')
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_user_id" uuid NOT NULL,
	"payer_kind" text NOT NULL,
	"payer_user_id" uuid,
	"payer_school_id" uuid,
	"plan_code" text NOT NULL,
	"status" text NOT NULL,
	"provider" text NOT NULL,
	"provider_subscription_id" text,
	"current_period_end" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"amount_minor_units" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"tenant_id" uuid DEFAULT '11111111-1111-4111-8111-111111111111' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_provider_key" UNIQUE("provider","provider_subscription_id"),
	CONSTRAINT "subscriptions_status_check" CHECK ("subscriptions"."status" in ('pending', 'active', 'past_due', 'cancelled', 'expired')),
	CONSTRAINT "subscriptions_payer_kind_check" CHECK ("subscriptions"."payer_kind" in ('user', 'school')),
	CONSTRAINT "subscriptions_payer_exactly_one_check" CHECK (("subscriptions"."payer_kind" = 'user' and "subscriptions"."payer_user_id" is not null and "subscriptions"."payer_school_id" is null)
          or ("subscriptions"."payer_kind" = 'school' and "subscriptions"."payer_school_id" is not null and "subscriptions"."payer_user_id" is null)),
	CONSTRAINT "subscriptions_plan_code_check" CHECK (length(btrim("subscriptions"."plan_code")) > 0),
	CONSTRAINT "subscriptions_amount_check" CHECK ("subscriptions"."amount_minor_units" >= 0),
	CONSTRAINT "subscriptions_currency_check" CHECK ("subscriptions"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "subscriptions_terminal_period_check" CHECK ("subscriptions"."status" not in ('cancelled', 'expired') or "subscriptions"."current_period_end" is not null)
);
--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_payer_user_id_users_id_fk" FOREIGN KEY ("payer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_payer_school_id_schools_id_fk" FOREIGN KEY ("payer_school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_events_subscription_idx" ON "payment_events" USING btree ("subscription_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payment_events_received_idx" ON "payment_events" USING btree ("received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_one_live_idx" ON "subscriptions" USING btree ("subject_user_id") WHERE status in ('pending', 'active', 'past_due');--> statement-breakpoint
CREATE INDEX "subscriptions_subject_idx" ON "subscriptions" USING btree ("subject_user_id");--> statement-breakpoint
CREATE INDEX "subscriptions_payer_user_idx" ON "subscriptions" USING btree ("payer_user_id");--> statement-breakpoint
CREATE INDEX "subscriptions_payer_school_idx" ON "subscriptions" USING btree ("payer_school_id");--> statement-breakpoint
CREATE INDEX "subscriptions_tenant_idx" ON "subscriptions" USING btree ("tenant_id");