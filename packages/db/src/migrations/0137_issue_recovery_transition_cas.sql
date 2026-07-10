ALTER TABLE "issue_recovery_actions"
  ADD COLUMN IF NOT EXISTS "revision" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "last_operation_id" text,
  ADD COLUMN IF NOT EXISTS "next_retry_at" timestamp with time zone;
