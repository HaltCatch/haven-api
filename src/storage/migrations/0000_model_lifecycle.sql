CREATE TABLE `models` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`draft` text NOT NULL,
	`draft_revision` integer DEFAULT 1 NOT NULL,
	`publication_revision` integer DEFAULT 0 NOT NULL,
	`published_version` integer,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `operations` (
	`model_id` text NOT NULL,
	`key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`result` text NOT NULL,
	PRIMARY KEY(`model_id`, `key`),
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `publications` (
	`model_id` text NOT NULL,
	`revision` integer NOT NULL,
	`version` integer NOT NULL,
	`kind` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`model_id`, `revision`),
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `versions` (
	`model_id` text NOT NULL,
	`version` integer NOT NULL,
	`document` text NOT NULL,
	`draft_revision` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`model_id`, `version`),
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE no action
);
