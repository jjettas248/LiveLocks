import { useState, useEffect, useRef } from "react";
import { Joyride, EVENTS, STATUS, type EventData } from "react-joyride";
import { apiRequest } from "@/lib/queryClient";

const TOUR_COMPLETED_KEY = "livelocks_onboarding_completed";

interface OnboardingTourProps {
  hasCompletedOnboarding: boolean;
  onComplete: () => void;
}

const STEPS = [
  {
    target: "body",
    placement: "center" as const,
    title: "Welcome to LiveLocks",
    content:
      "We surface live betting edges across the NBA, MLB, and NCAAB — updated play-by-play. Quick 30-second tour so you know where to look.",
    disableBeacon: true,
  },
  {
    target: '[data-testid="tab-calculator"]',
    title: "NBA Live Edges",
    content:
      "Live NBA props refreshed every play. Cards tagged Elite or Strong are our highest-conviction picks — those are where you spend your attention.",
    disableBeacon: true,
  },
  {
    target: '[data-testid="tab-mlb"]',
    title: "MLB + HR Radar",
    content:
      "Real-time per-inning props and our HR Radar — players flagged as heating up before they go yard. Edges sharpen mid-game as pitchers tire.",
    disableBeacon: true,
  },
  {
    target: '[data-testid="tab-ncaab"]',
    title: "NCAAB",
    content:
      "Same engine, college hoops. Best for second-half live swings when game scripts shift fast.",
    disableBeacon: true,
  },
  {
    target:
      '[data-testid="button-unlock-full-access-strip"], [data-testid="button-unlock-full-access-bar"]',
    title: "Upgrade Anytime",
    content:
      "Free includes a few daily plays. Upgrade for unlimited access, SMS alerts on top edges, and full HR Radar visibility.",
    disableBeacon: true,
  },
];

export function OnboardingTour({ hasCompletedOnboarding, onComplete }: OnboardingTourProps) {
  const [run, setRun] = useState(false);
  const persistedRef = useRef(false);

  const alreadyCompleted =
    hasCompletedOnboarding ||
    (typeof localStorage !== "undefined" &&
      localStorage.getItem(TOUR_COMPLETED_KEY) === "true");

  // Persist completion exactly once. Called as soon as the tour starts so it
  // never re-fires on refresh, and again on finish/skip as a backstop.
  const markCompleted = async () => {
    if (persistedRef.current) return;
    persistedRef.current = true;
    try {
      localStorage.setItem(TOUR_COMPLETED_KEY, "true");
    } catch {}
    try {
      await apiRequest("POST", "/api/user/complete-onboarding");
    } catch {}
    onComplete();
  };

  useEffect(() => {
    if (!alreadyCompleted) {
      const timer = setTimeout(() => setRun(true), 1000);
      return () => clearTimeout(timer);
    }
  }, [alreadyCompleted]);

  const handleEvent = async (data: EventData) => {
    const { status, type } = data;

    // Mark complete the moment the tour first renders — guarantees it never
    // fires twice even if the user refreshes mid-tour.
    if (type === EVENTS.TOUR_START && !persistedRef.current) {
      void markCompleted();
    }

    const finishedStatuses: string[] = [STATUS.FINISHED, STATUS.SKIPPED];
    if (finishedStatuses.includes(status)) {
      setRun(false);
      void markCompleted();
    }
  };

  if (alreadyCompleted) return null;

  return (
    <Joyride
      steps={STEPS}
      run={run}
      continuous
      onEvent={handleEvent}
      locale={{
        back: "Back",
        close: "Close",
        last: "Got it",
        next: "Next",
        skip: "Skip tour",
      }}
      options={{
        primaryColor: "#3b82f6",
        backgroundColor: "#18181b",
        textColor: "#e4e4e7",
        arrowColor: "#18181b",
        overlayColor: "rgba(0, 0, 0, 0.65)",
        zIndex: 10000,
        showProgress: true,
        buttons: ["back", "skip", "primary"],
        dismissKeyAction: "close",
        overlayClickAction: "close",
      }}
      styles={{
        tooltip: {
          borderRadius: "12px",
          padding: "18px",
          maxWidth: "360px",
        },
        tooltipTitle: {
          fontSize: "15px",
          fontWeight: 700,
          color: "#fafafa",
          marginBottom: "6px",
        },
        tooltipContent: {
          fontSize: "13px",
          lineHeight: "1.5",
          color: "#d4d4d8",
          padding: "0",
        },
        buttonPrimary: {
          borderRadius: "8px",
          padding: "8px 16px",
          fontSize: "13px",
          fontWeight: 600,
        },
        buttonBack: {
          color: "#a1a1aa",
          fontSize: "13px",
          marginRight: "8px",
        },
        buttonSkip: {
          color: "#71717a",
          fontSize: "12px",
        },
      }}
    />
  );
}
