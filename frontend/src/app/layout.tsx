import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Land Layout Optimizer",
  description: "Analyze plots and optimize residential building layouts",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased bg-neutral-50 min-h-screen">
        {children}
      </body>
    </html>
  );
}
