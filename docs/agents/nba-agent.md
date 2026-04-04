# NBA ENGINE AGENT — LOCKED SPEC

## SYSTEM
Core Engine → NBA

## OBJECTIVE
Generate low-frequency, high-confidence prop signals using time-based regression modeling.

## ENGINE TYPE
Continuous Time Model
- Driven by: game clock, possessions, minutes remaining
- Stabilized by: regression to season averages
- Output cadence: controlled, selective

## INPUTS (REQUIRED)

### Game Context
- Time remaining
- Score differential
- Pace (team + blended)
- Possessions estimate

### Player Context
- Minutes played / projected
- Usage rate
- Shot volume
- Foul risk

### Team Context
- Offensive rating
- Defensive rating
- Matchup defense (positional)

### Live Performance
- FG%, 3PT%, FT%
- Shot attempts
- Assists/rebounds pace

## CORE MODEL

### Projection Formula
```
Projected Stat =
  (blended_per_minute_rate)
  × (remaining_minutes)
  × pace_multiplier
  × defense_multiplier
  × shooting_regression
```

### REGRESSION RULE (MANDATORY)
- Halftime: heavy regression → season baseline
- Live: partial regression (capped influence)
- NEVER trust small sample hot streaks

## PROBABILITY MODEL
- Sigmoid / distribution-based mapping
- Hard caps:
  - Floor: 2%
  - Ceiling: 98%
  - Typical range: 52%–75%

## EDGE LOGIC
```
edge = probability - 50
```
- Filters:
  - Minimum edge: 8–12%
  - Must align with projection vs line
  - No contradiction allowed

## SIGNAL RULES
- ONLY trigger when:
  - Halftime OR controlled live window
  - Sufficient sample size
  - Stable projection confidence

## OUTPUT FREQUENCY
- LOW
- SELECTIVE
- TRUST > VOLUME

## FALLBACK MODE (REQUIRED)
If no plays:
- Lower edge threshold
- Maintain regression
- Return something

## FORBIDDEN
- Using EV / launch angle logic
- At-bat style triggers
- Momentum-only signals
- High-frequency spam

## OUTPUT CONTRACT
```json
{
  "plays": [],
  "engine": "NBA",
  "mode": "strict" | "fallback",
  "confidence": "low" | "medium" | "high",
  "diagnostics": {}
}
```
