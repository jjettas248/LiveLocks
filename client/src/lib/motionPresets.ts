import { useReducedMotion, type Variants } from "framer-motion";

/**
 * Tiny, shared framer-motion presets. The goal is consistent, restrained motion
 * — entrances, press feedback, subtle staggers, and number reveals — NOT
 * attention-grabbing animation on live data.
 *
 * Reduced motion: framer-motion drives transforms in JS, so the global CSS
 * `prefers-reduced-motion` block does NOT neutralize it. Components must gate
 * presets through `useMotionSafe()` (or pass the variants through
 * `respectReducedMotion`) so motion collapses to instant for users who opt out.
 *
 * Guardrails: never animate layout-critical values (width/height/top/left) that
 * cause CLS — these only touch opacity / transform.
 */

// Spring-like ease used across the app's CSS too (cubic-bezier(0.16,1,0.3,1)).
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

export const cardEnter: Variants = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.32, ease: EASE_OUT } },
};

export const pressTap = {
  whileTap: { scale: 0.98 },
  transition: { duration: 0.12, ease: EASE_OUT },
} as const;

export const staggerContainer: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.05, delayChildren: 0.02 } },
};

export const staggerItem: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.28, ease: EASE_OUT } },
};

export const numberReveal: Variants = {
  hidden: { opacity: 0, scale: 0.92 },
  visible: { opacity: 1, scale: 1, transition: { duration: 0.4, ease: EASE_OUT } },
};

/** Instant variant set used when the user prefers reduced motion. */
const INSTANT: Variants = {
  hidden: { opacity: 1 },
  visible: { opacity: 1, transition: { duration: 0 } },
};

/** Collapse any preset to an instant no-op when reduced motion is requested. */
export function respectReducedMotion(variants: Variants, reduced: boolean | null): Variants {
  return reduced ? INSTANT : variants;
}

/**
 * Hook returning `true` when motion is allowed. Use to gate `animate`/`variants`:
 *   const motionSafe = useMotionSafe();
 *   <motion.div variants={motionSafe ? cardEnter : undefined} ... />
 */
export function useMotionSafe(): boolean {
  return !useReducedMotion();
}
