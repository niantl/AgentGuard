import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

/**
 * Neutral ramp, tinted toward the brand hue (~218°) rather than pure gray.
 *
 * 300/400/500 are TEXT steps and every one of them clears WCAG AA (4.5:1) against
 * both surfaces in this product — the page (#0B0F19) and the card (#11192E), which
 * is the harder of the two. Measured on card:
 *   300 → 8.71:1   400 → 5.71:1   500 → 4.69:1
 * 600 and darker are STRUCTURE steps (borders, dividers, fills) and must never
 * carry text. The previous scale used Tailwind's untinted gray, where 500 sat at
 * 3.61:1 on card and quietly failed everywhere it was used as muted copy.
 */
const neutral = {
  50: "#f6f8fc",
  100: "#eaf0f9",
  200: "#d3ddee",
  300: "#a8b8d4",
  400: "#8494b4",
  500: "#7285a8",
  600: "#4d5c78",
  700: "#333f57",
  800: "#1e2740",
  900: "#131a2c",
  950: "#0b0f19",
} as const;

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        // Space Grotesk — headings, KPI figures, pipeline step labels.
        display: ["var(--font-display)", "Space Grotesk", "sans-serif"],
        // IBM Plex Sans — body copy and dense tabular readouts.
        sans: ["var(--font-body)", "IBM Plex Sans", "sans-serif"],
        // IBM Plex Mono — hashes, entry IDs, signatures, file paths.
        mono: ["var(--font-mono)", "IBM Plex Mono", "ui-monospace", "monospace"],
      },
      colors: {
        /* Razorpay Brand Colors */
        razorpay: {
          50: "#f0f5ff",
          100: "#e0e9ff",
          200: "#c7d9ff",
          300: "#a8c5ff",
          400: "#7ba8ff",
          500: "#0066FF",
          600: "#0052cc",
          700: "#003da6",
          800: "#002980",
          900: "#001a4d",
        },
        /* Accent Colors */
        accent: {
          orange: "#FF6B35",
          green: "#00B386",
          red: "#FF3333",
          yellow: "#FFB800",
          blue: "#0066FF",
        },
        neutral,
        /* Navy Fintech Surfaces */
        surface: {
          dark: "#0b0f19",
          card: "#11192e",
          hover: "#162038",
          border: "rgba(255, 255, 255, 0.08)",
        },
        /* Legacy ink colors (kept for backwards compatibility) */
        ink: {
          950: "#08090c",
          900: "#0c0e13",
          850: "#11141b",
          800: "#161a23",
          700: "#1f242f",
          600: "#2b313d",
        },
      },
      ringColor: {
        DEFAULT: "#7ba8ff",
        focus: "#7ba8ff",
        danger: "#fb7185",
      },
      ringOffsetColor: {
        page: neutral[950],
        card: "#11192e",
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "slide-in": "slideIn 0.3s ease-out",
        "fade-in": "fadeIn 0.3s ease-out",
        // Standing in for the removed `bounce-gentle`: elastic easing reads as
        // playful, which is wrong on a surface whose job is to look trustworthy.
        "breathe": "breathe 2.4s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "sheen": "sheen 2.2s cubic-bezier(0.4, 0, 0.2, 1) infinite",
      },
      keyframes: {
        slideIn: {
          "0%": { transform: "translateX(-20px)", opacity: "0" },
          "100%": { transform: "translateX(0)", opacity: "1" },
        },
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        breathe: {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.55", transform: "scale(0.96)" },
        },
        sheen: {
          "0%": { transform: "translateX(-110%)" },
          "60%, 100%": { transform: "translateX(210%)" },
        },
      },
      backgroundImage: {
        "gradient-razorpay": "linear-gradient(135deg, #0066FF 0%, #0052cc 100%)",
        "gradient-success": "linear-gradient(135deg, #00B386 0%, #008060 100%)",
        "gradient-warning": "linear-gradient(135deg, #FFB800 0%, #FF9500 100%)",
        "gradient-danger": "linear-gradient(135deg, #FF3333 0%, #CC0000 100%)",
      },
      transitionTimingFunction: {
        // Decisive entrances, no overshoot.
        "out-expo": "cubic-bezier(0.16, 1, 0.3, 1)",
        "in-out-quint": "cubic-bezier(0.83, 0, 0.17, 1)",
      },
    },
  },
  plugins: [
    plugin(({ addUtilities }) => {
      addUtilities({
        /**
         * Hides the scrollbar while keeping the element scrollable. Used by the
         * tab strip, which scrolls horizontally on narrow viewports; a raw
         * scrollbar there sits directly under the tabs and reads as a UI defect.
         * Anything using this MUST provide its own scroll affordance — see the
         * edge fades in DashboardTabs.
         */
        ".no-scrollbar": {
          "-ms-overflow-style": "none",
          "scrollbar-width": "none",
        },
        ".no-scrollbar::-webkit-scrollbar": {
          display: "none",
          width: "0",
          height: "0",
        },
      });
    }),
  ],
};

export default config;
