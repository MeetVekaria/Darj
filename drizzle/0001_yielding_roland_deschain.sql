CREATE TABLE `fault_injections` (
	`run_id` text NOT NULL,
	`flag` text NOT NULL,
	`remaining` integer NOT NULL,
	PRIMARY KEY(`run_id`, `flag`)
);
--> statement-breakpoint
CREATE TABLE `payment_attempts` (
	`run_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`payment_id` text NOT NULL,
	`outcome` text NOT NULL,
	`attempted_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `processing_jobs` (
	`run_id` text NOT NULL,
	`job_id` text NOT NULL,
	`custody_id` text NOT NULL,
	`state` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`available_at` text NOT NULL,
	`locked_at` text,
	`last_error_code` text,
	PRIMARY KEY(`run_id`, `job_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_processing_custody` ON `processing_jobs` (`run_id`,`custody_id`);--> statement-breakpoint
CREATE INDEX `idx_jobs_state` ON `processing_jobs` (`run_id`,`state`,`available_at`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key_hash` text PRIMARY KEY NOT NULL,
	`window_start` text NOT NULL,
	`request_count` integer NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_receipts` (
	`run_id` text NOT NULL,
	`receipt_id` text NOT NULL,
	`custody_id` text NOT NULL,
	`package_id` text NOT NULL,
	`package_hash` text NOT NULL,
	`received_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `receipt_id`),
	FOREIGN KEY (`run_id`,`custody_id`) REFERENCES `custody_submissions`(`run_id`,`custody_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_receipts`("run_id", "receipt_id", "custody_id", "package_id", "package_hash", "received_at") SELECT "run_id", "receipt_id", "custody_id", "package_id", "package_hash", "received_at" FROM `receipts`;--> statement-breakpoint
DROP TABLE `receipts`;--> statement-breakpoint
ALTER TABLE `__new_receipts` RENAME TO `receipts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_receipt_custody` ON `receipts` (`run_id`,`custody_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_receipt_package` ON `receipts` (`run_id`,`package_id`);