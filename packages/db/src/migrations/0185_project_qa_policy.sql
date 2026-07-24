ALTER TABLE "projects" ADD COLUMN "qa_policy" jsonb;
--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD COLUMN "evidence" jsonb;
