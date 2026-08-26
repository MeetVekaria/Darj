CREATE TABLE `guided_filing_sessions` (
	`run_id` text NOT NULL,
	`case_id` text NOT NULL,
	`state_json` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `case_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_guided_filing_updated` ON `guided_filing_sessions` (`run_id`,`updated_at`);