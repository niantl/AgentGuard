"use client";

import { useReducedMotion, type Transition, type Variants } from "motion/react";
import { useMemo } from "react";

/* ============================================================================
   Motion vocabulary
   Two rules hold everywhere in this product:

   1. No overshoot. Springs are critically-ish damped and easings are
      decelerating only. A bounce reads as playful, and nothing about a payment
      being refused should read as playful.
   2. Motion carries meaning, so under `prefers-reduced-motion` it is removed
      rather than merely shortened: offsets collapse to zero and loops stop, but
      the end state is always reached, so no information is lost.
   ========================================================================== */

/** Decelerating, no overshoot. The default for entrances. */
export const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;
/** Symmetric, for elements that move both ways (sliding indicators, reorder). */
export const EASE_IN_OUT_QUINT = [0.83, 0, 0.17, 1] as const;

/** Crisp; for hover/press feedback and small badges. */
export const SPRING_SNAP: Transition = {
  type: "spring",
  stiffness: 520,
  damping: 32,
  mass: 0.6,
};

/** Settled; for layout shifts and sliding indicators. */
export const SPRING_SOFT: Transition = {
  type: "spring",
  stiffness: 320,
  damping: 34,
  mass: 0.9,
};

/** For `layout` on numbers and bars that resize as the ledger moves. */
export const SPRING_LAYOUT: Transition = {
  type: "spring",
  stiffness: 260,
  damping: 30,
  mass: 0.8,
};

export const INSTANT: Transition = { duration: 0 };

/** Per-item delay for staggered list reveals, capped so long lists stay snappy. */
export function staggerDelay(index: number, step = 0.035, cap = 0.42): number {
  return Math.min(index * step, cap);
}

export interface MotionKit {
  /** True when the viewer asked for reduced motion. */
  reduced: boolean;
  /** Pass any transition through; returns an instant one under reduced motion. */
  t: (transition: Transition) => Transition;
  /** Motion props for an item rising into place, staggered by list position. */
  rise: (index?: number, distance?: number) => {
    initial: { opacity: number; y: number };
    animate: { opacity: number; y: number };
    transition: Transition;
  };
  /** Motion props for an item sliding in from the leading edge. */
  slideIn: (index?: number, distance?: number) => {
    initial: { opacity: number; x: number };
    animate: { opacity: number; x: number };
    transition: Transition;
  };
  /** Crossfade + slight vertical travel, for tab panels. */
  panel: (direction?: 1 | -1) => {
    initial: { opacity: number; y: number };
    animate: { opacity: number; y: number };
    exit: { opacity: number; y: number };
    transition: Transition;
  };
  /** Spring hover/press feedback. Empty objects under reduced motion. */
  press: (lift?: number) => {
    whileHover: { y?: number; scale?: number };
    whileTap: { scale?: number };
    transition: Transition;
  };
  /** A looping attention pulse — omitted entirely under reduced motion. */
  loop: (keyframes: number[], duration?: number) => {
    animate?: { scale: number[] };
    transition?: Transition;
  };
}

export function useMotionKit(): MotionKit {
  const reduced = useReducedMotion() ?? false;

  return useMemo<MotionKit>(() => {
    const t = (transition: Transition): Transition => (reduced ? INSTANT : transition);

    return {
      reduced,
      t,
      rise: (index = 0, distance = 10) => ({
        initial: { opacity: 0, y: reduced ? 0 : distance },
        animate: { opacity: 1, y: 0 },
        transition: reduced
          ? INSTANT
          : {
              duration: 0.42,
              ease: [...EASE_OUT_EXPO],
              delay: staggerDelay(index),
            },
      }),
      slideIn: (index = 0, distance = 10) => ({
        initial: { opacity: 0, x: reduced ? 0 : -distance },
        animate: { opacity: 1, x: 0 },
        transition: reduced
          ? INSTANT
          : {
              duration: 0.38,
              ease: [...EASE_OUT_EXPO],
              delay: staggerDelay(index),
            },
      }),
      panel: (direction = 1) => ({
        initial: { opacity: 0, y: reduced ? 0 : 8 * direction },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: reduced ? 0 : -6 * direction },
        transition: reduced ? INSTANT : { duration: 0.28, ease: [...EASE_OUT_EXPO] },
      }),
      press: (lift = 1) => ({
        whileHover: reduced ? {} : { y: -lift },
        whileTap: reduced ? {} : { scale: 0.98 },
        transition: reduced ? INSTANT : SPRING_SNAP,
      }),
      loop: (keyframes, duration = 1.8) =>
        reduced
          ? {}
          : {
              animate: { scale: keyframes },
              transition: {
                repeat: Number.POSITIVE_INFINITY,
                duration,
                ease: "easeInOut",
              },
            },
    };
  }, [reduced]);
}

/** Container variants for `staggerChildren`-driven lists. */
export const listContainer: Variants = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.035, delayChildren: 0.04 } },
};

export const listItem: Variants = {
  hidden: { opacity: 0, y: 8 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.34, ease: [...EASE_OUT_EXPO] } },
};
