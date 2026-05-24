import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { FirebaseAnalyticsBootstrap } from "@/components/firebase-analytics";
import "@copilotkit/react-ui/styles.css";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "BORDER WHERE?",
  description: "Search Philippine cities and render barangay boundary polygons on an interactive map.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <FirebaseAnalyticsBootstrap />
        {children}
      </body>
    </html>
  );
}
