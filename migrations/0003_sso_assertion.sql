CREATE TABLE `sso_assertion` (
	`tenant_id` text NOT NULL,
	`assertion_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `assertion_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON UPDATE no action ON DELETE no action
);
