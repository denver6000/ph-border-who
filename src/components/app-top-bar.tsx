"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "firebase/auth";
import { useState } from "react";

import { useAuth } from "@/components/auth-provider";
import { getFirebaseAuthClient } from "@/lib/firebase-client";

const NAV_ITEMS = [
  { href: "/", label: "Cities" },
  { href: "/barangays", label: "Barangays" },
  { href: "/compare", label: "Compare" },
];

export function AppTopBar() {
  const pathname = usePathname();
  const { user } = useAuth();
  const [isSigningOut, setIsSigningOut] = useState(false);

  if (pathname === "/login" || !user) {
    return null;
  }

  async function handleLogout() {
    const auth = getFirebaseAuthClient();

    if (!auth) {
      return;
    }

    setIsSigningOut(true);

    try {
      await signOut(auth);
    } finally {
      setIsSigningOut(false);
    }
  }

  return (
    <header className="app-top-bar">
      <div className="app-top-bar-inner">
        <Link href="/" className="app-brand">
          BORDER WHERE?
        </Link>
        <nav className="app-top-nav" aria-label="Primary">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href;

            return (
              <Link key={item.href} href={item.href} className={`app-top-link ${active ? "app-top-link-active" : ""}`}>
                {item.label}
              </Link>
            );
          })}
        </nav>
        <button className="app-top-action" disabled={isSigningOut} onClick={handleLogout} type="button">
          {isSigningOut ? "Logging out..." : "Logout"}
        </button>
      </div>
    </header>
  );
}
