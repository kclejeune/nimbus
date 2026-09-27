CREATE TABLE `revoked_token` (
	`jti` text PRIMARY KEY NOT NULL,
	`expires_at` integer,
	`revoked_at` integer NOT NULL,
	`reason` text NOT NULL
);
