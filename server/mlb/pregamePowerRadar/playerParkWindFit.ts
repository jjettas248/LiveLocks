// Pre-Game Power Radar — player-specific park/wind fit hydrator (PR2).
//
// DISPLAY/EXPLAINABILITY ONLY. Wraps the shared `parkWindFit` model output into
// the pregame display contract (PregamePlayerParkWindFit). Stamped onto the
// signal at build/API time; the client renders it verbatim. This module:
//   - never feeds score10 or any scoring component (pure display projection)
//   - exposes NO numeric model value (drops fitMultiplier / components)
//   - returns a safe fallback when venue / player / wind data is missing
//
// Single source of park/wind math: the shared module. No duplicated logic here.

import { computePlayerParkWindFit, type PlayerParkWindFitInput } from "../parkWindFit";
import type { PregamePlayerParkWindFit } from "./types";

/**
 * Sector-aware, plain-English wind direction for the card. Derived ONLY from the
 * shared model's resolved sector/blowing (server-side display formatting — the
 * client never re-derives this from raw wind).
 */
function windDirectionDisplay(
  blowing: "out" | "in" | "cross" | "calm" | "unknown",
  sector: "LF" | "CF" | "RF" | "IN" | "CROSS" | "CALM" | "UNKNOWN",
): string | null {
  switch (blowing) {
    case "out":
      if (sector === "LF") return "Out to LF";
      if (sector === "RF") return "Out to RF";
      if (sector === "CF") return "Out to CF";
      return "Out";
    case "in":
      return "Wind in";
    case "cross":
      return "Crosswind";
    case "calm":
      return "Calm";
    default:
      return null;
  }
}

/**
 * Hydrate the display-only park/wind fit for a pregame card. Always returns a
 * value (the shared helper itself collapses to a "❔ Park/wind data unavailable"
 * style fallback when data is missing), so the card always has something safe to
 * render.
 */
export function hydratePregamePlayerParkWindFit(
  input: PlayerParkWindFitInput,
): PregamePlayerParkWindFit {
  const fit = computePlayerParkWindFit(input);
  return {
    emoji: fit.emoji,
    label: fit.label,
    explanation: fit.explanation,
    windDirectionLabel: windDirectionDisplay(fit.windBlowing, fit.windSector),
    windSpeedMph: fit.windSpeedMph,
    classification: fit.classification,
    confidence: fit.confidence,
  };
}
