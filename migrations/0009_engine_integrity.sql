-- Tenant isolation for pay_exception: the same view and triggers as every tenant table (see 0001_tenant_isolation.sql).
CREATE VIEW `v_pay_exception` AS SELECT * FROM `pay_exception` WHERE `tenant_id` = current_tenant();
--> statement-breakpoint
CREATE TRIGGER `pay_exception_tenant_insert` BEFORE INSERT ON `pay_exception`
WHEN current_tenant() IS NULL OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: insert into pay_exception denied'); END;
--> statement-breakpoint
CREATE TRIGGER `pay_exception_tenant_update` BEFORE UPDATE ON `pay_exception`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant() OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: update of pay_exception denied'); END;
--> statement-breakpoint
CREATE TRIGGER `pay_exception_tenant_delete` BEFORE DELETE ON `pay_exception`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: delete from pay_exception denied'); END;
--> statement-breakpoint
-- D27 separation of duties: whoever created a payroll run can never be its approver.
CREATE TRIGGER `payroll_run_creator_not_approver_insert` BEFORE INSERT ON `payroll_run`
WHEN NEW.`approved_by` IS NOT NULL AND NEW.`approved_by` = NEW.`created_by`
BEGIN SELECT RAISE(ABORT, 'separation of duties: the creator of a payroll run cannot approve it'); END;
--> statement-breakpoint
CREATE TRIGGER `payroll_run_creator_not_approver_update` BEFORE UPDATE ON `payroll_run`
WHEN NEW.`approved_by` IS NOT NULL AND NEW.`approved_by` = NEW.`created_by`
BEGIN SELECT RAISE(ABORT, 'separation of duties: the creator of a payroll run cannot approve it'); END;
--> statement-breakpoint
-- Allowed status changes only: draft -> approved -> computed -> disbursed, approved -> failed, failed -> approved
-- (re-approval), computed -> failed (Layer 7, a batch that cannot be sent).
CREATE TRIGGER `payroll_run_status_transitions` BEFORE UPDATE OF `status` ON `payroll_run`
WHEN NEW.`status` IS NOT OLD.`status` AND NOT (
  (OLD.`status` = 'draft' AND NEW.`status` = 'approved')
  OR (OLD.`status` = 'approved' AND NEW.`status` IN ('computed', 'failed'))
  OR (OLD.`status` = 'failed' AND NEW.`status` = 'approved')
  OR (OLD.`status` = 'computed' AND NEW.`status` IN ('disbursed', 'failed'))
)
BEGIN SELECT RAISE(ABORT, 'invalid payroll run status change'); END;
--> statement-breakpoint
-- Replaces 0007's version: a failed run may be re-approved by a different approver; everything else stays frozen.
DROP TRIGGER `payroll_run_frozen_after_draft`;
--> statement-breakpoint
CREATE TRIGGER `payroll_run_frozen_after_draft` BEFORE UPDATE ON `payroll_run`
WHEN OLD.`status` <> 'draft' AND (
  NEW.`pay_date` IS NOT OLD.`pay_date`
  OR NEW.`scheduled_run_date` IS NOT OLD.`scheduled_run_date`
  OR NEW.`created_by` IS NOT OLD.`created_by`
  OR NEW.`status` = 'draft'
  OR (OLD.`approved_by` IS NOT NULL AND NEW.`approved_by` IS NOT OLD.`approved_by` AND OLD.`status` <> 'failed')
)
BEGIN SELECT RAISE(ABORT, 'payroll run is no longer a draft and cannot be edited'); END;
--> statement-breakpoint
-- Pay results and exceptions can be written only while the run is approved (inside the engine's transaction, just
-- before it moves the run to computed). Nothing can be added to a computed, failed, or disbursed run.
CREATE TRIGGER `pay_result_only_while_approved` BEFORE INSERT ON `pay_result`
WHEN (SELECT `status` FROM `payroll_run` WHERE `run_id` = NEW.`run_id`) IS NOT 'approved'
BEGIN SELECT RAISE(ABORT, 'pay results can only be written for an approved run'); END;
--> statement-breakpoint
CREATE TRIGGER `pay_exception_only_while_approved` BEFORE INSERT ON `pay_exception`
WHEN (SELECT `status` FROM `payroll_run` WHERE `run_id` = NEW.`run_id`) IS NOT 'approved'
BEGIN SELECT RAISE(ABORT, 'pay exceptions can only be written for an approved run'); END;
--> statement-breakpoint
CREATE TRIGGER `pay_result_immutable` BEFORE UPDATE ON `pay_result`
BEGIN SELECT RAISE(ABORT, 'pay results are immutable'); END;
