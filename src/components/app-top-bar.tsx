"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/", label: "Cities" },
  { href: "/municipalities", label: "Municipalities" },
  { href: "/barangays", label: "Barangays" },
  { href: "/geojson", label: "GeoJSON" },
  { href: "/compare", label: "Compare" },
];

export function AppTopBar() {
  const pathname = usePathname();

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
      </div>
    </header>
  );
}
