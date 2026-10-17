ALTER TABLE `ach_batch` ADD `entry_count` integer;--> statement-breakpoint
ALTER TABLE `ach_batch` ADD `total_credit_cents` integer;--> statement-breakpoint
ALTER TABLE `ach_batch` ADD `bank_reference` text;--> statement-breakpoint
ALTER TABLE `ach_batch` ADD `rejection_reason` text;