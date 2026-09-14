CREATE INDEX `api_token_user_idx` ON `api_token` (`user_id`);--> statement-breakpoint
CREATE INDEX `audit_log_created_idx` ON `audit_log` (`created_at`);