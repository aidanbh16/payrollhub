CREATE TABLE `pay_exception` (
	`exception_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`run_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`reason` text NOT NULL,
	FOREIGN KEY (`tenant_id`,`run_id`) REFERENCES `payroll_run`(`tenant_id`,`run_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`,`employee_id`) REFERENCES `employee`(`tenant_id`,`employee_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pay_exception_reason_check" CHECK("pay_exception"."reason" IN ('no_verified_bank_account'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pay_exception_run_employee` ON `pay_exception` (`run_id`,`employee_id`);--> statement-breakpoint
ALTER TABLE `payroll_run` ADD `failure_reason` text;