-- Tenant isolation for service_token_use: the same view and triggers as every tenant table (see 0001_tenant_isolation.sql).
CREATE VIEW `v_service_token_use` AS SELECT * FROM `service_token_use` WHERE `tenant_id` = current_tenant();
--> statement-breakpoint
CREATE TRIGGER `service_token_use_tenant_insert` BEFORE INSERT ON `service_token_use`
WHEN current_tenant() IS NULL OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: insert into service_token_use denied'); END;
--> statement-breakpoint
CREATE TRIGGER `service_token_use_tenant_update` BEFORE UPDATE ON `service_token_use`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant() OR NEW.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: update of service_token_use denied'); END;
--> statement-breakpoint
CREATE TRIGGER `service_token_use_tenant_delete` BEFORE DELETE ON `service_token_use`
WHEN current_tenant() IS NULL OR OLD.`tenant_id` IS NOT current_tenant()
BEGIN SELECT RAISE(ABORT, 'tenant isolation: delete from service_token_use denied'); END;
