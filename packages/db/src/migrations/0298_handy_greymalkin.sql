CREATE TABLE "qa_integration_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"pull_request_url" text NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"pull_number" integer NOT NULL,
	"pass_sha" text NOT NULL,
	"target_sha" text NOT NULL,
	"target_kind" text NOT NULL,
	"base_ref" text NOT NULL,
	"base_sha" text NOT NULL,
	"verified_head_sha" text,
	"config_digest" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"reason" text,
	"provenance" text,
	"target_tree_sha" text,
	"pushed_sha" text,
	"results" jsonb,
	"log_path" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "qa_integration_runs" ADD CONSTRAINT "qa_integration_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_integration_runs" ADD CONSTRAINT "qa_integration_runs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "qa_integration_runs_identity_uq" ON "qa_integration_runs" USING btree ("issue_id","kind","pass_sha","target_sha","base_sha","config_digest");--> statement-breakpoint
CREATE INDEX "qa_integration_runs_status_idx" ON "qa_integration_runs" USING btree ("status","created_at");--> statement-breakpoint