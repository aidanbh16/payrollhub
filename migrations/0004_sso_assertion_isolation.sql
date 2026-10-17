-- Tenant isolation for sso_assertion: the same view and triggers as every tenant table (see 0001_tenant_isolation.sql).
CREATE VIEW `v_sso_assertion` AS SELECT * FROM `sso_assertion` WHERE `tenant_id` = current_tenant();
--> statement-breakpoint
CREATE TRIGGER `sso_assertion_tenant_insert` BEFORE INSERT ON `sso_assertion`
WHEN current_tenant() IS NULL OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: insert into sso_assertion denied'); END;
--> statement-breakpoint
CREATE TRIGGER `sso_assertion_tenant_update` BEFORE UPDATE ON `sso_assertion`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant() OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: update of sso_assertion denied'); END;
--> statement-breakpoint
CREATE TRIGGER `sso_assertion_tenant_delete` BEFORE DELETE ON `sso_assertion`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: delete from sso_assertion denied'); END;
