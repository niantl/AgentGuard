import { IBM_Plex_Mono, IBM_Plex_Sans, Space_Grotesk } from "next/font/google";

/**
 * Typography pairing, loaded through `next/font` so the files are self-hosted and
 * subset at build time — no runtime <link>, no layout shift, no FOUT.
 *
 * - Space Grotesk (display): a grotesque descended from Space Mono. Wide apertures and
 *   near-monospaced digits, which is why it carries the KPI figures and pipeline step
 *   labels rather than a neutral UI face.
 * - IBM Plex Sans (body): built for dense operational readouts, and its tabular figures
 *   are genuinely well-fitted — the reason currency columns line up in the ledger.
 * - IBM Plex Mono (code): hashes, entry IDs, signatures, file paths.
 */

export const displayFont = Space_Grotesk({
  subsets: ["latin"],
  display: "swap",
  weight: ["500", "600", "700"],
  variable: "--font-display",
});

export const bodyFont = IBM_Plex_Sans({
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700"],
  variable: "--font-body",
});

export const monoFont = IBM_Plex_Mono({
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});

export const fontVariables = `${displayFont.variable} ${bodyFont.variable} ${monoFont.variable}`;
