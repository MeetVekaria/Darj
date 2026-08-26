CREATE TABLE `attachment_versions` (
	`run_id` text NOT NULL,
	`case_id` text NOT NULL,
	`slot` text NOT NULL,
	`version` integer NOT NULL,
	`filename` text NOT NULL,
	`object_key` text NOT NULL,
	`bytes` integer NOT NULL,
	`mime` text NOT NULL,
	`sha256` text NOT NULL,
	`verified_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `case_id`, `slot`, `version`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_attachment_version_object_key` ON `attachment_versions` (`object_key`);--> statement-breakpoint
CREATE INDEX `idx_attachment_versions_slot` ON `attachment_versions` (`run_id`,`case_id`,`slot`,`version`);