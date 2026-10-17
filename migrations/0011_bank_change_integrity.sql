-- Bank account changes (L2-11; Assignment 5, Section 3.3). Database backstops for the Bank Account service.
-- At most one pending change per employee: a new request must supersede the old one first.
CREATE UNIQUE INDEX `bank_account_change_one_pending` ON `bank_account_change` (`tenant_id`, `employee_id`) WHERE `status` = 'pending';
--> statement-breakpoint
-- A resolved change (confirmed, rejected, superseded) is a permanent record.
CREATE TRIGGER `bank_account_change_resolved_is_final` BEFORE UPDATE ON `bank_account_change`
WHEN OLD.`status` <> 'pending'
BEGIN SELECT RAISE(ABORT, 'a resolved bank account change cannot be modified'); END;
--> statement-breakpoint
-- The account numbers of a change cannot be swapped while it is pending.
CREATE TRIGGER `bank_account_change_numbers_fixed` BEFORE UPDATE ON `bank_account_change`
WHEN NEW.`new_routing_number` IS NOT OLD.`new_routing_number` OR NEW.`new_account_number` IS NOT OLD.`new_account_number`
  OR NEW.`employee_id` IS NOT OLD.`employee_id` OR NEW.`requested_by` IS NOT OLD.`requested_by`
BEGIN SELECT RAISE(ABORT, 'a bank account change cannot be altered'); END;
--> statement-breakpoint
-- A confirmation code is used once: consumed_at is set once and never changes again.
CREATE TRIGGER `verification_code_single_use` BEFORE UPDATE ON `verification_code`
WHEN OLD.`consumed_at` IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'a confirmation code can only be used once'); END;
--> statement-breakpoint
-- A retired bank account stays retired; account numbers of an account never change.
CREATE TRIGGER `bank_account_numbers_fixed` BEFORE UPDATE ON `bank_account`
WHEN NEW.`routing_number` IS NOT OLD.`routing_number` OR NEW.`account_number` IS NOT OLD.`account_number`
  OR NEW.`employee_id` IS NOT OLD.`employee_id` OR (OLD.`status` = 'retired' AND NEW.`status` <> 'retired')
BEGIN SELECT RAISE(ABORT, 'bank account numbers and retirements are permanent'); END;
--> statement-breakpoint
-- An employee's contact address is where bank-change confirmations go (D13), so it cannot be changed: changing contact
-- addresses is out of scope (see README), and this keeps any code path or SQL from redirecting confirmations.
CREATE TRIGGER `app_user_email_immutable` BEFORE UPDATE OF `email` ON `app_user`
WHEN NEW.`email` IS NOT OLD.`email`
BEGIN SELECT RAISE(ABORT, 'a user''s contact email cannot be changed'); END;
