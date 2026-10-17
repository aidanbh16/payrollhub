ALTER TABLE `app_user` ADD `totp_last_used_step` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `app_user_tenant_sso_subject` ON `app_user` (`tenant_id`,`sso_subject`);