import { useState, useEffect } from "react";
import { X } from "lucide-react";

interface WelcomeBannerProps {
  onExplore: () => void;
  onDismiss: () => void;
  subtitle: string;
  subtitleColor: string;
}

export function WelcomeBanner({ onExplore, onDismiss, subtitle, subtitleColor }: WelcomeBannerProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 60);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      style={{
        transform: visible ? "translateY(0)" : "translateY(-12px)",
        opacity: visible ? 1 : 0,
        transition: "transform 400ms cubic-bezier(0.34,1.56,0.64,1), opacity 300ms ease",
        background: "linear-gradient(135deg, #0a1a16 0%, #0f1f1a 50%, #091510 100%)",
        border: "1px solid hsl(var(--brand-accent) / 0.35)",
        borderRadius: 14,
        padding: "20px 24px",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0, left: 0, right: 0, bottom: 0,
          background: "radial-gradient(ellipse at top left, hsl(var(--brand-accent) / 0.06) 0%, transparent 60%)",
          pointerEvents: "none",
        }}
      />

      <button
        onClick={onDismiss}
        data-testid="welcome-banner-dismiss"
        style={{
          position: "absolute",
          top: 12, right: 12,
          background: "transparent",
          border: "none",
          cursor: "pointer",
          color: "#52525b",
          padding: 4,
          borderRadius: 6,
          lineHeight: 1,
        }}
        aria-label="Dismiss"
      >
        <X size={16} />
      </button>

      <div className="flex items-start gap-4">
        <div
          style={{
            width: 44, height: 44,
            borderRadius: 12,
            background: "hsl(var(--brand-accent) / 0.12)",
            border: "1px solid hsl(var(--brand-accent) / 0.25)",
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0,
            fontSize: 22,
          }}
        >
          🏀
        </div>

        <div className="flex-1 min-w-0">
          <p
            style={{
              color: "hsl(var(--brand-accent))",
              fontWeight: 700,
              fontSize: 15,
              letterSpacing: "-0.01em",
              marginBottom: 3,
            }}
          >
            Welcome to LiveLocks Pro
          </p>
          <p style={{ color: subtitleColor, fontSize: 13, marginBottom: 12 }}>
            {subtitle}
          </p>

          <div className="flex items-center gap-2">
            <button
              data-testid="welcome-banner-explore"
              onClick={onExplore}
              style={{
                background: "hsl(var(--brand-accent))",
                color: "#000000",
                fontWeight: 700,
                fontSize: 13,
                padding: "7px 16px",
                borderRadius: 8,
                border: "none",
                cursor: "pointer",
                letterSpacing: "0.02em",
              }}
            >
              Explore →
            </button>
            <button
              onClick={onDismiss}
              style={{
                background: "transparent",
                color: "#71717a",
                fontWeight: 500,
                fontSize: 13,
                padding: "7px 12px",
                borderRadius: 8,
                border: "1px solid #27272a",
                cursor: "pointer",
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
