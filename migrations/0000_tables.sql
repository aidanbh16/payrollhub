CREATE TABLE `ach_batch` (
	`batch_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`run_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`file_body` blob NOT NULL,
	`signature` blob,
	`signing_key_version` integer,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`tenant_id`,`run_id`) REFERENCES `payroll_run`(`tenant_id`,`run_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ach_batch_status_check" CHECK("ach_batch"."status" IN ('built', 'signed', 'sent', 'rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ach_batch_run` ON `ach_batch` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ach_batch_idempotency_key` ON `ach_batch` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `app_user` (
	`user_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`mfa_enrolled` integer NOT NULL,
	`sso_subject` text,
	`status` text NOT NULL,
	`password_hash` text,
	`totp_secret` blob,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "app_user_role_check" CHECK("app_user"."role" IN ('hr_admin', 'approver', 'employee')),
	CONSTRAINT "app_user_status_check" CHECK("app_user"."status" IN ('active', 'disabled')),
	CONSTRAINT "app_user_password_check" CHECK(("app_user"."role" = 'employee' AND "app_user"."password_hash" IS NULL) OR ("app_user"."role" <> 'employee' AND "app_user"."password_hash" IS NOT NULL)),
	CONSTRAINT "app_user_mfa_check" CHECK("app_user"."role" = 'employee' OR ("app_user"."mfa_enrolled" = 1 AND "app_user"."totp_secret" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_user_tenant_key` ON `app_user` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `app_user_tenant_email` ON `app_user` (`tenant_id`,`email`);--> statement-breakpoint
CREATE TABLE `approval_token` (
	`token_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`run_id` text NOT NULL,
	`issued_to` text NOT NULL,
	`key_version` integer NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`redeemed_at` integer,
	FOREIGN KEY (`tenant_id`,`run_id`) REFERENCES `payroll_run`(`tenant_id`,`run_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`,`issued_to`) REFERENCES `app_user`(`tenant_id`,`user_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "approval_token_expiry_check" CHECK("approval_token"."expires_at" > "approval_token"."issued_at")
);
--> statement-breakpoint
CREATE TABLE `bank_account` (
	`bank_account_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`routing_number` blob NOT NULL,
	`account_number` blob NOT NULL,
	`account_last4` text NOT NULL,
	`status` text NOT NULL,
	`verified_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`,`employee_id`) REFERENCES `employee`(`tenant_id`,`employee_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bank_account_status_check" CHECK("bank_account"."status" IN ('verified', 'retired')),
	CONSTRAINT "bank_account_last4_check" CHECK(length("bank_account"."account_last4") = 4)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bank_account_tenant_key` ON `bank_account` (`tenant_id`,`bank_account_id`);--> statement-breakpoint
CREATE TABLE `bank_account_change` (
	`change_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`new_routing_number` blob NOT NULL,
	`new_account_number` blob NOT NULL,
	`status` text NOT NULL,
	`requested_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`tenant_id`,`employee_id`) REFERENCES `employee`(`tenant_id`,`employee_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`,`requested_by`) REFERENCES `app_user`(`tenant_id`,`user_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bank_account_change_status_check" CHECK("bank_account_change"."status" IN ('pending', 'confirmed', 'rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bank_account_change_tenant_key` ON `bank_account_change` (`tenant_id`,`change_id`);--> statement-breakpoint
CREATE TABLE `employee` (
	`employee_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`full_name` text NOT NULL,
	`status` text NOT NULL,
	`pay_rate_cents` integer NOT NULL,
	FOREIGN KEY (`tenant_id`,`user_id`) REFERENCES `app_user`(`tenant_id`,`user_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "employee_status_check" CHECK("employee"."status" IN ('active', 'terminated')),
	CONSTRAINT "employee_pay_rate_check" CHECK("employee"."pay_rate_cents" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `employee_tenant_key` ON `employee` (`tenant_id`,`employee_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `employee_tenant_user` ON `employee` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `pay_result` (
	`result_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`run_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`bank_account_id` text NOT NULL,
	`gross_pay_cents` integer NOT NULL,
	`net_pay_cents` integer NOT NULL,
	FOREIGN KEY (`tenant_id`,`run_id`) REFERENCES `payroll_run`(`tenant_id`,`run_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`,`employee_id`) REFERENCES `employee`(`tenant_id`,`employee_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`,`bank_account_id`) REFERENCES `bank_account`(`tenant_id`,`bank_account_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pay_result_amount_check" CHECK("pay_result"."net_pay_cents" >= 0 AND "pay_result"."net_pay_cents" <= "pay_result"."gross_pay_cents")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pay_result_run_employee` ON `pay_result` (`run_id`,`employee_id`);--> statement-breakpoint
CREATE TABLE `payroll_run` (
	`run_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`pay_date` text NOT NULL,
	`scheduled_run_date` text NOT NULL,
	`status` text NOT NULL,
	`created_by` text NOT NULL,
	`approved_by` text,
	FOREIGN KEY (`tenant_id`,`created_by`) REFERENCES `app_user`(`tenant_id`,`user_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`,`approved_by`) REFERENCES `app_user`(`tenant_id`,`user_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payroll_run_status_check" CHECK("payroll_run"."status" IN ('draft', 'approved', 'computed', 'disbursed', 'failed')),
	CONSTRAINT "payroll_run_day_early_check" CHECK("payroll_run"."scheduled_run_date" = date("payroll_run"."pay_date", '-1 day'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payroll_run_tenant_key` ON `payroll_run` (`tenant_id`,`run_id`);--> statement-breakpoint
CREATE TABLE `service_grant` (
	`grant_id` text PRIMARY KEY NOT NULL,
	`calling_service` text NOT NULL,
	`target_endpoint` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_grant_target` ON `service_grant` (`calling_service`,`target_endpoint`,`scope`);--> statement-breakpoint
CREATE TABLE `session` (
	`session_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`device_binding` text NOT NULL,
	`mfa_verified_at` integer,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`tenant_id`,`user_id`) REFERENCES `app_user`(`tenant_id`,`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tenant` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`withholding_rate_bp` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "tenant_status_check" CHECK("tenant"."status" IN ('active', 'suspended')),
	CONSTRAINT "tenant_withholding_check" CHECK("tenant"."withholding_rate_bp" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE `tenant_idp_config` (
	`idp_config_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`issuer` text NOT NULL,
	`audience` text NOT NULL,
	`signing_cert` text NOT NULL,
	`cert_expires_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_idp_config_tenant` ON `tenant_idp_config` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `verification_code` (
	`code_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`change_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`attempts` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	FOREIGN KEY (`tenant_id`,`change_id`) REFERENCES `bank_account_change`(`tenant_id`,`change_id`) ON UPDATE no action ON DELETE no action
);
