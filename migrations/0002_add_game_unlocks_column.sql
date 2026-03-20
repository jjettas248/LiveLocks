ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "unlocked_game_ids_today" text NOT NULL DEFAULT '[]';
