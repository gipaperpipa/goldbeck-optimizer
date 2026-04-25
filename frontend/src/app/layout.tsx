import type { Metadata } from "next";
import { Inter_Tight, JetBrains_Mono, Instrument_Serif } from "next/font/google";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { GlobalShortcuts } from "@/components/ui/global-shortcuts";
import "./globals.css";

const interTight = Inter_Tight({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter-tight",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
  variable: "--font-instrument-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Goldbeck Optimizer",
  description: "Grundriss-Optimierung für das Goldbeck-Fertigteilsystem",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="de"
      className={`${interTight.variable} ${jetbrainsMono.variable} ${instrumentSerif.variable}`}
    >
      <body className="antialiased bg-neutral-50 min-h-screen">
        <GlobalShortcuts />
        <ErrorBoundary>{children}</ErrorBoundary>
      </body>
    </html>
  );
}
