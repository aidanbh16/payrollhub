-- Tenant isolation: the SQLite equivalent of PostgreSQL row-level security (Assignment 5, Sections 2.5 and 3.4).
-- Hand-written custom migration; this is one of the only places raw SQL is allowed.
--
-- current_tenant() and in_platform_scope() are registered on every connection by data/db/connection.ts.
-- current_tenant() is NULL outside a withTenant() block, so:
--   * v_<table> views (the read policy) return only the current tenant's rows, and nothing when no tenant is set;
--   * BEFORE INSERT / UPDATE / DELETE triggers (the WITH CHECK policy) abort any write whose tenant_id
--     does not match the current tenant, including every write when no tenant is set.
-- IS NOT is used instead of <> so that a NULL on either side counts as a mismatch.

-- tenant
CREATE VIEW `v_tenant` AS SELECT * FROM `tenant` WHERE `tenant_id` = current_tenant();
--> statement-breakpoint
CREATE TRIGGER `tenant_tenant_insert` BEFORE INSERT ON `tenant`
WHEN current_tenant() IS NULL OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: insert into tenant denied'); END;
--> statement-breakpoint
CREATE TRIGGER `tenant_tenant_update` BEFORE UPDATE ON `tenant`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant() OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: update of tenant denied'); END;
--> statement-breakpoint
CREATE TRIGGER `tenant_tenant_delete` BEFORE DELETE ON `tenant`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: delete from tenant denied'); END;
--> statement-breakpoint

-- app_user
CREATE VIEW `v_app_user` AS SELECT * FROM `app_user` WHERE `tenant_id` = current_tenant();
--> statement-breakpoint
CREATE TRIGGER `app_user_tenant_insert` BEFORE INSERT ON `app_user`
WHEN current_tenant() IS NULL OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: insert into app_user denied'); END;
--> statement-breakpoint
CREATE TRIGGER `app_user_tenant_update` BEFORE UPDATE ON `app_user`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant() OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: update of app_user denied'); END;
--> statement-breakpoint
CREATE TRIGGER `app_user_tenant_delete` BEFORE DELETE ON `app_user`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: delete from app_user denied'); END;
--> statement-breakpoint

-- session
CREATE VIEW `v_session` AS SELECT * FROM `session` WHERE `tenant_id` = current_tenant();
--> statement-breakpoint
CREATE TRIGGER `session_tenant_insert` BEFORE INSERT ON `session`
WHEN current_tenant() IS NULL OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: insert into session denied'); END;
--> statement-breakpoint
CREATE TRIGGER `session_tenant_update` BEFORE UPDATE ON `session`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant() OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: update of session denied'); END;
--> statement-breakpoint
CREATE TRIGGER `session_tenant_delete` BEFORE DELETE ON `session`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: delete from session denied'); END;
--> statement-breakpoint

-- tenant_idp_config
CREATE VIEW `v_tenant_idp_config` AS SELECT * FROM `tenant_idp_config` WHERE `tenant_id` = current_tenant();
--> statement-breakpoint
CREATE TRIGGER `tenant_idp_config_tenant_insert` BEFORE INSERT ON `tenant_idp_config`
WHEN current_tenant() IS NULL OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: insert into tenant_idp_config denied'); END;
--> statement-breakpoint
CREATE TRIGGER `tenant_idp_config_tenant_update` BEFORE UPDATE ON `tenant_idp_config`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant() OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: update of tenant_idp_config denied'); END;
--> statement-breakpoint
CREATE TRIGGER `tenant_idp_config_tenant_delete` BEFORE DELETE ON `tenant_idp_config`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: delete from tenant_idp_config denied'); END;
--> statement-breakpoint

-- employee
CREATE VIEW `v_employee` AS SELECT * FROM `employee` WHERE `tenant_id` = current_tenant();
--> statement-breakpoint
CREATE TRIGGER `employee_tenant_insert` BEFORE INSERT ON `employee`
WHEN current_tenant() IS NULL OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: insert into employee denied'); END;
--> statement-breakpoint
CREATE TRIGGER `employee_tenant_update` BEFORE UPDATE ON `employee`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant() OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: update of employee denied'); END;
--> statement-breakpoint
CREATE TRIGGER `employee_tenant_delete` BEFORE DELETE ON `employee`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: delete from employee denied'); END;
--> statement-breakpoint

-- payroll_run
CREATE VIEW `v_payroll_run` AS SELECT * FROM `payroll_run` WHERE `tenant_id` = current_tenant();
--> statement-breakpoint
CREATE TRIGGER `payroll_run_tenant_insert` BEFORE INSERT ON `payroll_run`
WHEN current_tenant() IS NULL OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: insert into payroll_run denied'); END;
--> statement-breakpoint
CREATE TRIGGER `payroll_run_tenant_update` BEFORE UPDATE ON `payroll_run`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant() OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: update of payroll_run denied'); END;
--> statement-breakpoint
CREATE TRIGGER `payroll_run_tenant_delete` BEFORE DELETE ON `payroll_run`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: delete from payroll_run denied'); END;
--> statement-breakpoint

-- approval_token
CREATE VIEW `v_approval_token` AS SELECT * FROM `approval_token` WHERE `tenant_id` = current_tenant();
--> statement-breakpoint
CREATE TRIGGER `approval_token_tenant_insert` BEFORE INSERT ON `approval_token`
WHEN current_tenant() IS NULL OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: insert into approval_token denied'); END;
--> statement-breakpoint
CREATE TRIGGER `approval_token_tenant_update` BEFORE UPDATE ON `approval_token`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant() OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: update of approval_token denied'); END;
--> statement-breakpoint
CREATE TRIGGER `approval_token_tenant_delete` BEFORE DELETE ON `approval_token`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: delete from approval_token denied'); END;
--> statement-breakpoint

-- pay_result
CREATE VIEW `v_pay_result` AS SELECT * FROM `pay_result` WHERE `tenant_id` = current_tenant();
--> statement-breakpoint
CREATE TRIGGER `pay_result_tenant_insert` BEFORE INSERT ON `pay_result`
WHEN current_tenant() IS NULL OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: insert into pay_result denied'); END;
--> statement-breakpoint
CREATE TRIGGER `pay_result_tenant_update` BEFORE UPDATE ON `pay_result`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant() OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: update of pay_result denied'); END;
--> statement-breakpoint
CREATE TRIGGER `pay_result_tenant_delete` BEFORE DELETE ON `pay_result`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: delete from pay_result denied'); END;
--> statement-breakpoint

-- bank_account
CREATE VIEW `v_bank_account` AS SELECT * FROM `bank_account` WHERE `tenant_id` = current_tenant();
--> statement-breakpoint
CREATE TRIGGER `bank_account_tenant_insert` BEFORE INSERT ON `bank_account`
WHEN current_tenant() IS NULL OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: insert into bank_account denied'); END;
--> statement-breakpoint
CREATE TRIGGER `bank_account_tenant_update` BEFORE UPDATE ON `bank_account`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant() OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: update of bank_account denied'); END;
--> statement-breakpoint
CREATE TRIGGER `bank_account_tenant_delete` BEFORE DELETE ON `bank_account`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: delete from bank_account denied'); END;
--> statement-breakpoint

-- bank_account_change
CREATE VIEW `v_bank_account_change` AS SELECT * FROM `bank_account_change` WHERE `tenant_id` = current_tenant();
--> statement-breakpoint
CREATE TRIGGER `bank_account_change_tenant_insert` BEFORE INSERT ON `bank_account_change`
WHEN current_tenant() IS NULL OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: insert into bank_account_change denied'); END;
--> statement-breakpoint
CREATE TRIGGER `bank_account_change_tenant_update` BEFORE UPDATE ON `bank_account_change`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant() OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: update of bank_account_change denied'); END;
--> statement-breakpoint
CREATE TRIGGER `bank_account_change_tenant_delete` BEFORE DELETE ON `bank_account_change`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: delete from bank_account_change denied'); END;
--> statement-breakpoint

-- verification_code
CREATE VIEW `v_verification_code` AS SELECT * FROM `verification_code` WHERE `tenant_id` = current_tenant();
--> statement-breakpoint
CREATE TRIGGER `verification_code_tenant_insert` BEFORE INSERT ON `verification_code`
WHEN current_tenant() IS NULL OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: insert into verification_code denied'); END;
--> statement-breakpoint
CREATE TRIGGER `verification_code_tenant_update` BEFORE UPDATE ON `verification_code`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant() OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: update of verification_code denied'); END;
--> statement-breakpoint
CREATE TRIGGER `verification_code_tenant_delete` BEFORE DELETE ON `verification_code`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: delete from verification_code denied'); END;
--> statement-breakpoint

-- ach_batch
CREATE VIEW `v_ach_batch` AS SELECT * FROM `ach_batch` WHERE `tenant_id` = current_tenant();
--> statement-breakpoint
CREATE TRIGGER `ach_batch_tenant_insert` BEFORE INSERT ON `ach_batch`
WHEN current_tenant() IS NULL OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: insert into ach_batch denied'); END;
--> statement-breakpoint
CREATE TRIGGER `ach_batch_tenant_update` BEFORE UPDATE ON `ach_batch`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant() OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: update of ach_batch denied'); END;
--> statement-breakpoint
CREATE TRIGGER `ach_batch_tenant_delete` BEFORE DELETE ON `ach_batch`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: delete from ach_batch denied'); END;
--> statement-breakpoint

-- service_grant: platform-level (no tenant_id). Readable and writable only inside a platform scope (Identity & Access).
CREATE VIEW `v_service_grant` AS SELECT * FROM `service_grant` WHERE in_platform_scope() = 1;
--> statement-breakpoint
CREATE TRIGGER `service_grant_platform_insert` BEFORE INSERT ON `service_grant`
WHEN in_platform_scope() IS NOT 1
BEGIN SELECT RAISE(ABORT, 'service_grant is writable only in a platform scope'); END;
--> statement-breakpoint
CREATE TRIGGER `service_grant_platform_update` BEFORE UPDATE ON `service_grant`
WHEN in_platform_scope() IS NOT 1
BEGIN SELECT RAISE(ABORT, 'service_grant is writable only in a platform scope'); END;
--> statement-breakpoint
CREATE TRIGGER `service_grant_platform_delete` BEFORE DELETE ON `service_grant`
WHEN in_platform_scope() IS NOT 1
BEGIN SELECT RAISE(ABORT, 'service_grant is writable only in a platform scope'); END;
