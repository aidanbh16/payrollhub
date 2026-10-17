CREATE TABLE `service_token_use` (
	`tenant_id` text NOT NULL,
	`token_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `token_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON UPDATE no action ON DELETE no action
);
