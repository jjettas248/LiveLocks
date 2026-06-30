import { apiRequest } from "./queryClient";

type RailEventType =
  | "impression"
  | "primary_cta_click"
  | "alerts_cta_click"
  | "upgrade_modal_opened";

type RailEventPayload = {
  eventType: RailEventType;
  exhausted?: boolean;
  playsUsedToday?: number;
  playsLimit?: number;
};

export async function trackRailEvent(payload: RailEventPayload): Promise<void> {
  try {
    await apiRequest("POST", "/api/analytics/rail-event", payload);
  } catch (err) {
    if (typeof console !== "undefined") {
      console.warn("[railAnalytics] failed to record", payload.eventType, err);
    }
  }
}
