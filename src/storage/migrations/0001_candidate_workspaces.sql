CREATE TABLE `candidate_operations` (
	`candidate_id` text NOT NULL,
	`key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`receipt` text NOT NULL,
	PRIMARY KEY(`candidate_id`, `key`),
	FOREIGN KEY (`candidate_id`) REFERENCES `candidates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`base_draft_revision` integer NOT NULL,
	`source_session_id` text NOT NULL,
	`source_edit_revision` integer NOT NULL,
	`source_document` text NOT NULL,
	`source_hash` text NOT NULL,
	`document` text NOT NULL,
	`document_hash` text NOT NULL,
	`capability_fingerprint` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`operation_count` integer DEFAULT 0 NOT NULL,
	`operation_bytes` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `candidates_model_status_idx` ON `candidates` (`model_id`,`status`);