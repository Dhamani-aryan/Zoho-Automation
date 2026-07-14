import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        canvas: "#09090B",
        surface: "#111113",
        ink: "#FAFAFA",
        muted: "#A1A1AA",
        subtle: "#71717A",
        line: "#232326",
        accent: "#3B82F6",
        success: "#22C55E",
        running: "#3B82F6",
        pending: "#F97316",
        idle: "#71717A",
        warn: "#F97316",
        danger: "#EF4444"
      },
      boxShadow: {
        soft: "none"
      }
    }
  },
  plugins: []
};

export default config;
