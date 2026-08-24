CREATE TABLE `attachments` (
	`run_id` text NOT NULL,
	`case_id` text NOT NULL,
	`slot` text NOT NULL,
	`filename` text NOT NULL,
	`object_key` text NOT NULL,
	`bytes` integer NOT NULL,
	`mime` text NOT NULL,
	`sha256` text NOT NULL,
	`verified_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `case_id`, `slot`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_attachment_object_key` ON `attachments` (`object_key`);--> statement-breakpoint
CREATE TABLE `case_events` (
	`run_id` text NOT NULL,
	`case_id` text NOT NULL,
	`seq` integer NOT NULL,
	`event_type` text NOT NULL,
	`actor` text NOT NULL,
	`detail` text NOT NULL,
	`occurred_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `case_id`, `seq`)
);
--> statement-breakpoint
CREATE INDEX `idx_events_case` ON `case_events` (`run_id`,`case_id`,`seq`);--> statement-breakpoint
CREATE TABLE `custody_submissions` (
	`run_id` text NOT NULL,
	`custody_id` text NOT NULL,
	`package_id` text NOT NULL,
	`canonical_payload` text NOT NULL,
	`package_hash` text NOT NULL,
	`received_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `custody_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_custody_package` ON `custody_submissions` (`run_id`,`package_id`);--> statement-breakpoint
CREATE TABLE `demo_runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`processor_paused` integer DEFAULT 0 NOT NULL,
	`lose_submission` integer DEFAULT 1 NOT NULL,
	`lose_payment` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `draft_snapshots` (
	`run_id` text NOT NULL,
	`case_id` text NOT NULL,
	`version` integer NOT NULL,
	`base_version` integer,
	`form_json` text NOT NULL,
	`changed_paths` text NOT NULL,
	`saved_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `case_id`, `version`)
);
--> statement-breakpoint
CREATE INDEX `idx_drafts_latest` ON `draft_snapshots` (`run_id`,`case_id`,`version`);--> statement-breakpoint
CREATE TABLE `filing_packages` (
	`run_id` text NOT NULL,
	`package_id` text NOT NULL,
	`case_id` text NOT NULL,
	`version` integer NOT NULL,
	`canonical_payload` text NOT NULL,
	`package_hash` text NOT NULL,
	`rule_version` text NOT NULL,
	`sealed_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `package_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_package_case_version` ON `filing_packages` (`run_id`,`case_id`,`version`);--> statement-breakpoint
CREATE TABLE `payment_events` (
	`run_id` text NOT NULL,
	`provider_event_id` text NOT NULL,
	`payment_id` text NOT NULL,
	`event_type` text NOT NULL,
	`received_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `provider_event_id`)
);
--> statement-breakpoint
CREATE TABLE `payment_intents` (
	`run_id` text NOT NULL,
	`payment_id` text NOT NULL,
	`custody_id` text NOT NULL,
	`state` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`reconciliation_reference` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `payment_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_payment_custody` ON `payment_intents` (`run_id`,`custody_id`);--> statement-breakpoint
CREATE TABLE `receipts` (
	`run_id` text NOT NULL,
	`receipt_id` text NOT NULL,
	`custody_id` text NOT NULL,
	`package_id` text NOT NULL,
	`package_hash` text NOT NULL,
	`received_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `receipt_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_receipt_custody` ON `receipts` (`run_id`,`custody_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_receipt_package` ON `receipts` (`run_id`,`package_id`);--> statement-breakpoint
CREATE TABLE `submission_attempts` (
	`run_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`package_id` text NOT NULL,
	`receipt_id` text,
	`outcome` text NOT NULL,
	`attempted_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `synthetic_signatures` (
	`run_id` text NOT NULL,
	`signature_id` text NOT NULL,
	`package_id` text NOT NULL,
	`provider` text NOT NULL,
	`signed_hash` text NOT NULL,
	`signature_value` text NOT NULL,
	`signed_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `signature_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_signature_package` ON `synthetic_signatures` (`run_id`,`package_id`);