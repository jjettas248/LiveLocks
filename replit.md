# NBA Live Line Probability Calculator

## Overview
A full-stack NBA betting tool that calculates the probability of a player hitting a live prop line at halftime. It factors in foul-based minute projections, opponent defense by position, real team pace data, and optionally live halftime scores from ESPN.

## Architecture
- **Frontend**: React + Vite, Tailwind CSS, shadcn/ui, TanStack Query, react-hook-form, framer-motion
- **Backend**: Express.js (TypeScript, tsx)
- **Database**: PostgreSQL via Drizzle ORM
- **Shared types**: `shared/schema.ts` and `shared/routes.ts`

## Key Features
- 200 players across all 30 NBA teams (2024-25 rosters), grouped by team in dropdown
- 10 stat types: Points, Rebounds, Assists, Steals, Blocks, and 5 combo props
- Real 2024-25 team defensive ratings per position (30 teams × 5 positions)
- Real 2024-25 team pace data (possessions/48 min) blended 60/40 with live game pace
- ESPN live scoreboard proxy (`GET /api/live-games`) — refreshes every 30s, no API key needed
- Live game cards auto-fill halftime score and opponent team
- Foul trouble penalty: 3 fouls = 30% minute reduction, 4 fouls = 55% reduction
- Probability engine outputs: probability, expected total, projected 2H minutes, defense multiplier, pace multiplier, pace label, team/opponent pace

## Database Tables
- `players` — id, name, team (3-letter abbr), position (PG/SG/SF/PF/C), avgMinutes, avgFouls
- `team_defense` — id, teamName, position, defRating (0.88–1.12 scale around 1.0 = league avg)

## API Routes
- `GET /api/players` — all players sorted alphabetically
- `GET /api/teams` — distinct team abbreviations sorted alphabetically
- `POST /api/calculate` — main probability calculation
- `GET /api/live-games` — ESPN live NBA scoreboard proxy

## Team Pace (TEAM_PACE constant in server/storage.ts)
Hardcoded 2024-25 NBA team pace values (possessions/48 min). League average ≈ 99.5.

## Probability Model
1. Derive per-minute rate from halftime stats
2. Project remaining minutes (foul penalty applied)
3. Multiply by defense rating (opponent's tendency vs player's position)
4. Multiply by blended pace multiplier (team historical + live game score)
5. Sigmoid-style: `probability = 50 + difference × scaleFactor` (clamped 2–98%)
6. Scale factors: points=8, rebounds/assists=10, steals/blocks=15, combos=6
