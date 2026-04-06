import { useState, useEffect } from "react";
import { Joyride, CallBackProps, STATUS } from "react-joyride";
import { apiRequest } from "@/lib/queryClient";

const TOUR_COMPLETED_KEY = "livelocks_onboarding_completed";

interface OnboardingTourProps {
  hasCompletedOnboarding: boolean;
  onComplete: () => void;
}

const STEPS = [
  {
    target: '[data-testid="tab-calculator"]',
    content: "This is your NBA Live board — real-time probability edges updated every play during live games.",
    disableBeacon: true,
  },
  {
    target: '[data-testid="tab-mlb"]',
    content: "MLB signals update by inning — the strongest edges appear mid-game as pitcher fatigue sets in.",
    disableBeacon: true,
  },
  {
    target: '[data-testid="tab-ncaab"]',
    content: "NCAAB predictions give you an edge on college basketball props.",
    disableBeacon: true,
  },
  {
    target: '[data-testid="button-unlock-full-access-strip"], [data-testid="button-unlock-full-access-bar"]',
    content: "Upgrade anytime to unlock unlimited access, SMS alerts, and the full MLB engine.",
    disableBeacon: true,
  },
];

export function OnboardingTour({ hasCompletedOnboarding, onComplete }: OnboardingTourProps) {
  const [run, setRun] = useState(false);

  const alreadyCompleted = hasCompletedOnboarding || (typeof localStorage !== "undefined" && localStorage.getItem(TOUR_COMPLETED_KEY) === "true");

  useEffect(() => {
    if (!alreadyCompleted) {
      const timer = setTimeout(() => setRun(true), 1000);
      return () => clearTimeout(timer);
    }
  }, [alreadyCompleted]);

  const handleCallback = async (data: CallBackProps) => {
    const { status } = data;
    const finishedStatuses: string[] = [STATUS.FINISHED, STATUS.SKIPPED];

    if (finishedStatuses.includes(status)) {
      setRun(false);
      try {
        localStorage.setItem(TOUR_COMPLETED_KEY, "true");
      } catch {}
      try {
        await apiRequest("POST", "/api/user/complete-onboarding");
      } catch {}
      onComplete();
    }
  };

  if (alreadyCompleted) return null;

  return (
    <Joyride
      steps={STEPS}
      run={run}
      continuous
      showSkipButton
      showProgress
      callback={handleCallback}
      styles={{
        options: {
          primaryColor: "#3b82f6",
          backgroundColor: "#18181b",
          textColor: "#e4e4e7",
          arrowColor: "#18181b",
          zIndex: 10000,
        },
        tooltip: {
          borderRadius: "12px",
          padding: "16px",
        },
        buttonNext: {
          borderRadius: "8px",
          padding: "8px 16px",
          fontSize: "13px",
          fontWeight: 600,
        },
        buttonBack: {
          color: "#a1a1aa",
          fontSize: "13px",
        },
        buttonSkip: {
          color: "#71717a",
          fontSize: "12px",
        },
      }}
    />
  );
}
