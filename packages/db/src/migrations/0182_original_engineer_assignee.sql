ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "original_engineer_assignee_agent_id" uuid;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issues_original_engineer_assignee_agent_id_agents_id_fk') THEN
		ALTER TABLE "issues" ADD CONSTRAINT "issues_original_engineer_assignee_agent_id_agents_id_fk" FOREIGN KEY ("original_engineer_assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
-- Backfill: issues currently assigned to an engineer get that engineer recorded as
-- the original assignee retroactively. Known limitation: an issue mid-QA-bounce at
-- deploy time (current assignee is QA, not an engineer) is not backfilled here -- its
-- pointer stays null until its next engineer assignment, which sets it going forward
-- (see issueService.update/create in server/src/services/issues.ts).
UPDATE "issues" AS i
SET "original_engineer_assignee_agent_id" = i."assignee_agent_id"
FROM "agents" AS a
WHERE i."assignee_agent_id" = a."id"
  AND a."role" = 'engineer'
  AND i."original_engineer_assignee_agent_id" IS NULL;
