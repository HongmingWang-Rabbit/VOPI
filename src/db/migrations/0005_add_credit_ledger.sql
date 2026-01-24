-- Add credits_balance and stripe_customer_id columns to users table
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "credits_balance" integer DEFAULT 0 NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "stripe_customer_id" varchar(255);

-- Create credit_transactions table
CREATE TABLE IF NOT EXISTS "credit_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"credits_delta" integer NOT NULL,
	"type" varchar(30) NOT NULL,
	"idempotency_key" varchar(255),
	"stripe_payment_intent_id" varchar(255),
	"stripe_checkout_session_id" varchar(255),
	"job_id" uuid,
	"description" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "credit_transactions_idempotency_key_unique" UNIQUE("idempotency_key")
);

-- Create stripe_events table
CREATE TABLE IF NOT EXISTS "stripe_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" varchar(255) NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"processed_at" timestamp,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_events_event_id_unique" UNIQUE("event_id")
);

-- Create signup_grants table
CREATE TABLE IF NOT EXISTS "signup_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"ip_address" varchar(45),
	"device_fingerprint" varchar(255),
	"email" varchar(255) NOT NULL,
	"granted_at" timestamp DEFAULT now() NOT NULL,
	"transaction_id" uuid,
	CONSTRAINT "signup_grants_user_id_unique" UNIQUE("user_id")
);

-- Add indexes for credit_transactions
CREATE INDEX IF NOT EXISTS "credit_transactions_user_id_idx" ON "credit_transactions" ("user_id");
CREATE INDEX IF NOT EXISTS "credit_transactions_type_idx" ON "credit_transactions" ("type");
CREATE INDEX IF NOT EXISTS "credit_transactions_created_at_idx" ON "credit_transactions" ("created_at");
-- Composite index for efficient balance history queries (user_id + created_at DESC)
CREATE INDEX IF NOT EXISTS "credit_transactions_user_created_idx" ON "credit_transactions" ("user_id", "created_at" DESC);

-- Add indexes for signup_grants
CREATE INDEX IF NOT EXISTS "signup_grants_ip_address_idx" ON "signup_grants" ("ip_address");
CREATE INDEX IF NOT EXISTS "signup_grants_device_fingerprint_idx" ON "signup_grants" ("device_fingerprint");

-- Add index on users.stripe_customer_id for faster Stripe customer lookups
CREATE INDEX IF NOT EXISTS "users_stripe_customer_id_idx" ON "users" ("stripe_customer_id") WHERE "stripe_customer_id" IS NOT NULL;

-- Add foreign key constraints
DO $$ BEGIN
 ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "signup_grants" ADD CONSTRAINT "signup_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "signup_grants" ADD CONSTRAINT "signup_grants_transaction_id_credit_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "credit_transactions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
