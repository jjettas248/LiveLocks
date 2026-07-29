// Mound Radar V2 (shadow) — persistence adapter.
//
// Bridges the storage-free shadow store to storage.ts — exactly mirrors
// ../moundPersistence.ts's role for production Mound signals ("Imports
// storage here (NOT in the build/scoring modules) so the engine stays
// storage-free and unit-testable"). Idempotent install; safe to call more
// than once.

import { storage } from "../../../../storage";
import { setMoundV2ShadowPersistenceSink } from "./moundV2ShadowStore";

let installed = false;

/** Wire the Mound V2 shadow durable-persistence sink. Idempotent. */
export function installMoundV2ShadowPersistence(): void {
  if (installed) return;
  installed = true;

  setMoundV2ShadowPersistenceSink(async (rows) => {
    for (const row of rows) {
      await storage.createMoundV2ShadowPrediction(row);
    }
  });
}
