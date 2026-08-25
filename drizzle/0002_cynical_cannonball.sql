CREATE TABLE `case_master_state` (
	`run_id` text NOT NULL,
	`case_id` text NOT NULL,
	`pinned_version` integer NOT NULL,
	`pinned_office` text NOT NULL,
	`current_version` integer NOT NULL,
	`current_office` text NOT NULL,
	`source` text NOT NULL,
	`review_state` text NOT NULL,
	`detected_at` text,
	`reviewed_at` text,
	PRIMARY KEY(`run_id`, `case_id`)
);
--> statement-breakpoint
CREATE TABLE `correction_requests` (
	`run_id` text NOT NULL,
	`request_id` text NOT NULL,
	`case_id` text NOT NULL,
	`source_package_id` text NOT NULL,
	`document_slot` text NOT NULL,
	`summary` text NOT NULL,
	`state` text NOT NULL,
	`child_package_id` text,
	`created_at` text NOT NULL,
	`resolved_at` text,
	PRIMARY KEY(`run_id`, `request_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_open_correction_source` ON `correction_requests` (`run_id`,`source_package_id`);--> statement-breakpoint
CREATE TABLE `package_lineage` (
	`run_id` text NOT NULL,
	`child_package_id` text NOT NULL,
	`parent_package_id` text NOT NULL,
	`reason` text NOT NULL,
	`changed_paths_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `child_package_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_lineage_parent_child` ON `package_lineage` (`run_id`,`parent_package_id`,`child_package_id`);--> statement-breakpoint
CREATE TABLE `upload_sessions` (
	`run_id` text NOT NULL,
	`upload_id` text NOT NULL,
	`case_id` text NOT NULL,
	`slot` text NOT NULL,
	`filename` text NOT NULL,
	`expected_bytes` integer NOT NULL,
	`confirmed_offset` integer DEFAULT 0 NOT NULL,
	`client_sha256` text NOT NULL,
	`fingerprint` text NOT NULL,
	`object_key` text NOT NULL,
	`provider_upload_id` text,
	`uploaded_parts_json` text DEFAULT '[]' NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`expires_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `upload_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_upload_id` ON `upload_sessions` (`upload_id`);--> statement-breakpoint
CREATE INDEX `idx_upload_slot` ON `upload_sessions` (`run_id`,`case_id`,`slot`,`state`);