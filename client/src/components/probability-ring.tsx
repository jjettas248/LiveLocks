import { motion } from "framer-motion";
import { useEffect, useState } from "react";

interface ProbabilityRingProps {
  probability: number;
  size?: number;
  strokeWidth?: number;
}

export function ProbabilityRing({ 
  probability, 
  size = 200, 
  strokeWidth = 16 
}: ProbabilityRingProps) {
  const [animatedValue, setAnimatedValue] = useState(0);
  
  useEffect(() => {
    // Small delay to ensure smooth entry animation
    const timeout = setTimeout(() => {
      setAnimatedValue(probability);
    }, 100);
    return () => clearTimeout(timeout);
  }, [probability]);

  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const strokeDashoffset = circumference - (animatedValue / 100) * circumference;

  // Determine color based on probability
  let colorClass = "text-primary";
  let glowClass = "filter drop-shadow-[0_0_8px_rgba(59,130,246,0.6)]";
  
  if (probability >= 65) {
    colorClass = "text-[#22c55e]"; // success
    glowClass = "filter drop-shadow-[0_0_8px_rgba(34,197,94,0.6)]";
  } else if (probability <= 35) {
    colorClass = "text-[#e11d48]"; // destructive
    glowClass = "filter drop-shadow-[0_0_8px_rgba(225,29,72,0.6)]";
  }

  return (
    <div
      className="relative flex items-center justify-center"
      style={{ width: size, maxWidth: "100%", aspectRatio: "1 / 1" }}
    >
      {/* Background Ring — viewBox lets the SVG scale down fluidly on narrow
          phones instead of forcing a fixed px box that overflows the card. */}
      <svg
        className="absolute inset-0 w-full h-full transform -rotate-90"
        viewBox={`0 0 ${size} ${size}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
          className="stroke-muted fill-transparent"
        />
        {/* Foreground Animated Ring */}
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset }}
          transition={{ duration: 1.5, ease: "easeOut" }}
          className={`fill-transparent stroke-current ${colorClass} ${glowClass}`}
          strokeLinecap="round"
        />
      </svg>
      
      {/* Value Display */}
      <div className="absolute flex flex-col items-center justify-center text-center">
        <motion.span 
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.5, duration: 0.5 }}
          className={`text-3xl sm:text-4xl md:text-5xl font-display font-bold ${colorClass}`}
        >
          {probability.toFixed(1)}%
        </motion.span>
        <motion.span 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.8, duration: 0.5 }}
          className="text-sm text-muted-foreground uppercase tracking-wider mt-1 font-semibold"
        >
          Model Prob
        </motion.span>
      </div>
    </div>
  );
}
