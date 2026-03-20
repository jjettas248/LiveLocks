CREATE TABLE IF NOT EXISTS "app_settings" (
        "id" serial PRIMARY KEY NOT NULL,
        "slate_reset_hour" integer DEFAULT 6 NOT NULL,
        "slate_reset_minute" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feedback" (
        "id" serial PRIMARY KEY NOT NULL,
        "user_id" integer,
        "message" text NOT NULL,
        "created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "halftime_play_alerts" (
        "id" serial PRIMARY KEY NOT NULL,
        "game_id" text NOT NULL,
        "game_date" text NOT NULL,
        "player_id" integer NOT NULL,
        "player_name" text NOT NULL,
        "team" text NOT NULL,
        "opponent" text NOT NULL,
        "stat_type" text NOT NULL,
        "halftime_stat" numeric NOT NULL,
        "line" numeric NOT NULL,
        "probability" numeric NOT NULL,
        "bet_direction" text NOT NULL,
        "created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "parlay_picks" (
        "id" serial PRIMARY KEY NOT NULL,
        "session_id" text NOT NULL,
        "player_id" integer NOT NULL,
        "stat_type" text NOT NULL,
        "line" numeric NOT NULL,
        "sportsbook" text NOT NULL,
        "probability" numeric NOT NULL,
        "odds_american" integer,
        "game_id" text,
        "added_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "persisted_plays" (
        "id" text PRIMARY KEY NOT NULL,
        "created_at" timestamp DEFAULT now(),
        "game_id" text NOT NULL,
        "player_id" text,
        "player_name" text NOT NULL,
        "team" text,
        "sport" text DEFAULT 'nba' NOT NULL,
        "market" text NOT NULL,
        "direction" text NOT NULL,
        "line" numeric NOT NULL,
        "prob" numeric NOT NULL,
        "engine_prob" numeric,
        "book_implied" numeric,
        "edge_gap" numeric,
        "game_date" text NOT NULL,
        "timestamp" timestamp NOT NULL,
        "result" text,
        "final_stat" numeric,
        "settled_at" timestamp,
        "notification_sent" boolean DEFAULT false,
        "duplicate_guard" text,
        CONSTRAINT "persisted_plays_duplicate_guard_unique" UNIQUE("duplicate_guard")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "play_results" (
        "id" serial PRIMARY KEY NOT NULL,
        "alert_id" integer NOT NULL,
        "actual_stat" numeric NOT NULL,
        "hit" boolean NOT NULL,
        "resolved_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "players" (
        "id" serial PRIMARY KEY NOT NULL,
        "name" text NOT NULL,
        "team" text NOT NULL,
        "position" text NOT NULL,
        "avg_minutes" numeric NOT NULL,
        "avg_fouls" numeric NOT NULL,
        "ppg" numeric,
        "rpg" numeric,
        "apg" numeric,
        "spg" numeric,
        "bpg" numeric,
        "tpg" numeric,
        "usage_rate" numeric,
        "off_rating" numeric,
        "ts_pct" numeric,
        "h2ppg" numeric,
        "h2rpg" numeric,
        "h2apg" numeric,
        "h2spg" numeric,
        "h2bpg" numeric,
        "h2tpg" numeric,
        "h2_avg_minutes" numeric,
        "stats_updated_at" timestamp,
        "projected_minutes" numeric,
        "projection_source" text,
        "projection_updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sent_alerts" (
        "id" serial PRIMARY KEY NOT NULL,
        "fingerprint" text NOT NULL,
        "user_id" integer,
        "sent_at" timestamp DEFAULT now(),
        CONSTRAINT "sent_alerts_fingerprint_unique" UNIQUE("fingerprint")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "team_defense" (
        "id" serial PRIMARY KEY NOT NULL,
        "team_name" text NOT NULL,
        "position" text NOT NULL,
        "def_rating" numeric NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
        "id" serial PRIMARY KEY NOT NULL,
        "email" text NOT NULL,
        "password_hash" text NOT NULL,
        "is_admin" boolean DEFAULT false NOT NULL,
        "subscription_tier" text,
        "plays_used" integer DEFAULT 0 NOT NULL,
        "stripe_customer_id" text,
        "stripe_subscription_id" text,
        "created_at" timestamp DEFAULT now(),
        "push_subscription" text,
        "push_alerts" boolean DEFAULT false NOT NULL,
        "phone_number" text,
        "sms_alerts" boolean DEFAULT false NOT NULL,
        "sms_consent" boolean DEFAULT false NOT NULL,
        "is_new_pro_user" boolean DEFAULT false,
        "requires_refresh" boolean DEFAULT false,
        "upgraded_at" text,
        "email_verified" boolean DEFAULT false NOT NULL,
        "email_verification_token" text,
        "original_email" text,
        "normalized_email" text,
        "signup_fingerprint" text,
        "verification_last_sent_at" timestamp,
        "sent_welcome" boolean DEFAULT false NOT NULL,
        "sent_walkthrough" boolean DEFAULT false NOT NULL,
        "sent_day3" boolean DEFAULT false NOT NULL,
        "sent_winback" boolean DEFAULT false NOT NULL,
        "sent_wall" boolean DEFAULT false NOT NULL,
        "sent_pro_welcome" boolean DEFAULT false NOT NULL,
        "sent_all_sports_welcome" boolean DEFAULT false NOT NULL,
        CONSTRAINT "users_email_unique" UNIQUE("email"),
        CONSTRAINT "users_normalized_email_unique" UNIQUE("normalized_email")
);
--> statement-breakpoint
ALTER TABLE "sent_alerts" ADD CONSTRAINT "sent_alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "persisted_plays_game_date_idx" ON "persisted_plays" USING btree ("game_date");--> statement-breakpoint
CREATE INDEX "persisted_plays_result_idx" ON "persisted_plays" USING btree ("result");--> statement-breakpoint
CREATE INDEX "persisted_plays_sport_idx" ON "persisted_plays" USING btree ("sport");--> statement-breakpoint
CREATE INDEX "idx_sent_alerts_fingerprint" ON "sent_alerts" USING btree ("fingerprint","user_id");