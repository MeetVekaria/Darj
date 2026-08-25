CREATE TABLE `service_drafts` (
	`run_id` text NOT NULL,
	`filing_id` text NOT NULL,
	`form_code` text NOT NULL,
	`title` text NOT NULL,
	`financial_year` text NOT NULL,
	`applicant_name` text NOT NULL,
	`note` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `filing_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_service_drafts_run_updated` ON `service_drafts` (`run_id`,`updated_at`);