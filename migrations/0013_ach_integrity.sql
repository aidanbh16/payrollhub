-- ACH Disbursement integrity (L2-13, L1-22; Assignment 5, Sections 2.4 and 3.3). Database backstops for the service.
-- A batch is created only for a computed run, already signed, with its control totals equal to the run's pay results.
CREATE TRIGGER `ach_batch_insert_rules` BEFORE INSERT ON `ach_batch`
WHEN (SELECT `status` FROM `payroll_run` WHERE `run_id` = NEW.`run_id`) IS NOT 'computed'
  OR NEW.`status` <> 'signed' OR NEW.`signature` IS NULL OR NEW.`signing_key_version` IS NULL
  OR NEW.`entry_count` IS NOT (SELECT count(*) FROM `pay_result` WHERE `run_id` = NEW.`run_id` AND `net_pay_cents` > 0)
  OR NEW.`total_credit_cents` IS NOT (SELECT coalesce(sum(`net_pay_cents`), 0) FROM `pay_result` WHERE `run_id` = NEW.`run_id`)
BEGIN SELECT RAISE(ABORT, 'an ACH batch needs a computed run, a signature, and totals equal to its pay results'); END;
--> statement-breakpoint
-- What was signed never changes.
CREATE TRIGGER `ach_batch_immutable` BEFORE UPDATE ON `ach_batch`
WHEN NEW.`batch_id` IS NOT OLD.`batch_id` OR NEW.`run_id` IS NOT OLD.`run_id` OR NEW.`idempotency_key` IS NOT OLD.`idempotency_key`
  OR NEW.`file_body` IS NOT OLD.`file_body` OR NEW.`signature` IS NOT OLD.`signature`
  OR NEW.`signing_key_version` IS NOT OLD.`signing_key_version` OR NEW.`created_at` IS NOT OLD.`created_at`
  OR NEW.`entry_count` IS NOT OLD.`entry_count` OR NEW.`total_credit_cents` IS NOT OLD.`total_credit_cents`
BEGIN SELECT RAISE(ABORT, 'a signed ACH batch cannot be altered'); END;
--> statement-breakpoint
-- signed -> sent | rejected; a rejected batch may be sent again (the same signed bytes). A sent batch is final.
CREATE TRIGGER `ach_batch_status_transitions` BEFORE UPDATE OF `status` ON `ach_batch`
WHEN NEW.`status` IS NOT OLD.`status` AND NOT (
  (OLD.`status` = 'signed' AND NEW.`status` IN ('sent', 'rejected'))
  OR (OLD.`status` = 'rejected' AND NEW.`status` = 'sent')
)
BEGIN SELECT RAISE(ABORT, 'invalid ACH batch status change'); END;
--> statement-breakpoint
CREATE TRIGGER `ach_batch_no_delete` BEFORE DELETE ON `ach_batch`
BEGIN SELECT RAISE(ABORT, 'ACH batches are permanent records'); END;
--> statement-breakpoint
-- A run that failed because a bank account changed after it was computed is closed: it has pay results, so it can
-- never be approved and computed again. A new run pays those employees (D35).
DROP TRIGGER `payroll_run_status_transitions`;
--> statement-breakpoint
CREATE TRIGGER `payroll_run_status_transitions` BEFORE UPDATE OF `status` ON `payroll_run`
WHEN NEW.`status` IS NOT OLD.`status` AND NOT (
  (OLD.`status` = 'draft' AND NEW.`status` = 'approved')
  OR (OLD.`status` = 'approved' AND NEW.`status` IN ('computed', 'failed'))
  OR (OLD.`status` = 'failed' AND NEW.`status` = 'approved' AND OLD.`failure_reason` IN ('content_changed', 'computation_error'))
  OR (OLD.`status` = 'computed' AND NEW.`status` IN ('disbursed', 'failed'))
)
BEGIN SELECT RAISE(ABORT, 'invalid payroll run status change'); END;
--> statement-breakpoint
-- A run is disbursed only once its batch has been accepted by the bank.
CREATE TRIGGER `payroll_run_disbursed_needs_sent_batch` BEFORE UPDATE OF `status` ON `payroll_run`
WHEN NEW.`status` = 'disbursed' AND OLD.`status` <> 'disbursed'
  AND (SELECT `status` FROM `ach_batch` WHERE `run_id` = NEW.`run_id`) IS NOT 'sent'
BEGIN SELECT RAISE(ABORT, 'a run is disbursed only after its batch is sent'); END;
