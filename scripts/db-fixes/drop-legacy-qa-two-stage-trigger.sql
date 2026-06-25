-- Local Paperclip restore guard for Manué's NSS instance.
-- Keep this until upstream Paperclip includes PR #6591 or an equivalent fix.
-- Safe/idempotent: used by restore-founding-engineer.sh after updates.
-- Purpose: prevent the legacy QA two-stage trigger from re-assigning an
-- agent -> human in_review handoff back to QA while leaving assignee_user_id set.

DROP TRIGGER IF EXISTS qa_two_stage_flow_trigger ON issues;
DROP FUNCTION IF EXISTS handle_qa_two_stage_flow();
