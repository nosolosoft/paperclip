ALTER TABLE "agent_api_keys"
  ADD COLUMN IF NOT EXISTS "rotated_from_key_id" uuid,
  ADD COLUMN IF NOT EXISTS "rotation_idempotency_key" text;

CREATE UNIQUE INDEX IF NOT EXISTS "agent_api_keys_rotation_idempotency_uq"
  ON "agent_api_keys" ("company_id", "rotated_from_key_id", "rotation_idempotency_key");
