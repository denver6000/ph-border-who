import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { AppTopBar } from "@/components/app-top-bar";
import { FirebaseAnalyticsBootstrap } from "@/components/firebase-analytics";
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
  title: "City Barangay Boundary Explorer",
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
      <body className="min-h-full flex flex-col">
        <FirebaseAnalyticsBootstrap />
        <AppTopBar />
        <main className="app-main">{children}</main>
      </body>
    </html>
  );
}
