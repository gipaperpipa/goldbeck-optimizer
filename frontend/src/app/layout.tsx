import type { Metadata } from "next";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { GlobalShortcuts } from "@/components/ui/global-shortcuts";
import "./globals.css";

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
    <html lang="de">
      <body className="antialiased bg-neutral-50 min-h-screen">
        <GlobalShortcuts />
        <ErrorBoundary>{children}</ErrorBoundary>
      </body>
    </html>
  );
}
