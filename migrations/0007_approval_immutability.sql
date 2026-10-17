-- Approval integrity, enforced by the database as a backstop to Payroll Approval and Payroll Engine (L2-01, L2-18).
-- A payroll run is editable only while it is a draft: once approved, its pay date, schedule, and creator are fixed, it
-- cannot return to draft, and its approver cannot be replaced.
CREATE TRIGGER `payroll_run_frozen_after_draft` BEFORE UPDATE ON `payroll_run`
WHEN OLD.`status` <> 'draft' AND (
  NEW.`pay_date` IS NOT OLD.`pay_date`
  OR NEW.`scheduled_run_date` IS NOT OLD.`scheduled_run_date`
  OR NEW.`created_by` IS NOT OLD.`created_by`
  OR NEW.`status` = 'draft'
  OR (OLD.`approved_by` IS NOT NULL AND NEW.`approved_by` IS NOT OLD.`approved_by`)
)
BEGIN SELECT RAISE(ABORT, 'payroll run is no longer a draft and cannot be edited'); END;
--> statement-breakpoint
-- An approval token record is an audit record: never deleted, and the only change allowed is setting redeemed_at once.
CREATE TRIGGER `approval_token_write_once` BEFORE UPDATE ON `approval_token`
WHEN OLD.`redeemed_at` IS NOT NULL
  OR NEW.`token_id` IS NOT OLD.`token_id` OR NEW.`run_id` IS NOT OLD.`run_id` OR NEW.`issued_to` IS NOT OLD.`issued_to`
  OR NEW.`key_version` IS NOT OLD.`key_version` OR NEW.`issued_at` IS NOT OLD.`issued_at` OR NEW.`expires_at` IS NOT OLD.`expires_at`
BEGIN SELECT RAISE(ABORT, 'approval tokens are write-once'); END;
--> statement-breakpoint
CREATE TRIGGER `approval_token_no_delete` BEFORE DELETE ON `approval_token`
BEGIN SELECT RAISE(ABORT, 'approval tokens cannot be deleted'); END;
