ALTER TABLE `user` ADD `status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
UPDATE `user` SET `status` = 'active';
