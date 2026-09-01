import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
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
        /* Neutral Palette */
        neutral: {
          50: "#f9fafb",
          100: "#f3f4f6",
          200: "#e5e7eb",
          300: "#d1d5db",
          400: "#9ca3af",
          500: "#6b7280",
          600: "#4b5563",
          700: "#374151",
          800: "#1f2937",
          900: "#0f1117",
        },
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
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "slide-in": "slideIn 0.3s ease-out",
        "fade-in": "fadeIn 0.3s ease-out",
        "bounce-gentle": "bounce 2s ease-in-out infinite",
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
      },
      backgroundImage: {
        "gradient-razorpay": "linear-gradient(135deg, #0066FF 0%, #0052cc 100%)",
        "gradient-success": "linear-gradient(135deg, #00B386 0%, #008060 100%)",
        "gradient-warning": "linear-gradient(135deg, #FFB800 0%, #FF9500 100%)",
        "gradient-danger": "linear-gradient(135deg, #FF3333 0%, #CC0000 100%)",
      },
    },
  },
  plugins: [],
};

export default config;
