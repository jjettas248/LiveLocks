ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "plays_used_today" integer NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "plays_reset_date" text;
