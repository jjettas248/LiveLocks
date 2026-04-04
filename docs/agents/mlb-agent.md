# MLB ENGINE AGENT — LOCKED SPEC

## SYSTEM
Core Engine → MLB

## OBJECTIVE
Generate high-frequency, event-driven signals using contact quality + situational context.

## ENGINE TYPE
Discrete Event Model (AB-based)
- Driven by: each at-bat
- NOT time dependent
- Output cadence: continuous

## INPUTS (REQUIRED)

### Contact Data (CRITICAL)
- Exit Velocity (EV)
- Launch Angle (LA)
- Distance
- Bat Speed

### Pitch Context
- Pitch type
- Pitch velocity
- Pitcher fatigue
- Times through order

### Game Context
- Inning
- Bullpen status
- Score pressure

### Environment
- Park factor
- Weather (wind)

## CORE MODEL

### Contact Quality Scoring
- EV > 95 → strong
- LA 8–32 → ideal HR band
- Distance > 340 → HR capable

### SIGNAL TRIGGERS

**Tier 1 (Strong)**
- Multiple high-quality contacts
- Consistent bat speed
- Favorable matchup

**Tier 2 (Explosive)**
- Single elite contact event
- Immediate HR potential

### NO REGRESSION RULE
- DO NOT regress to season averages mid-game
- MLB is momentum + contact driven

## PROBABILITY MODEL
- Event-weighted confidence
- Soft cap: ~82%
- Volatility is expected

## EDGE LOGIC
- NO HARD EDGE FILTER
- Instead use confidence tiering:
  - elite
  - strong
  - developing

## SIGNAL RULES
- ALWAYS ALLOW SURFACING IF:
  - Signal exists
  - Contact supports it

## OUTPUT FREQUENCY
- HIGH
- CONTINUOUS
- EVENT-DRIVEN

## FALLBACK MODE
If no signals:
- Relax contact thresholds
- Surface developing signals
- NEVER return empty

## FORBIDDEN
- Using pace or minutes
- Regression models
- NBA-style probability filtering
- Waiting for "perfect conditions"

## OUTPUT CONTRACT
```json
{
  "plays": [],
  "engine": "MLB",
  "mode": "strict" | "fallback",
  "confidence": "developing" | "strong" | "elite",
  "contactProfile": {},
  "diagnostics": {}
}
```
