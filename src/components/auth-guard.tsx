"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { useAuth } from "@/components/auth-provider";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { isLoading, user } = useAuth();

  useEffect(() => {
    if (!isLoading && !user) {
      const next = pathname && pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : "";
      router.replace(`/login${next}`);
    }
  }, [isLoading, pathname, router, user]);

  if (isLoading) {
    return (
      <div className="auth-message-shell">
        <p className="auth-message-text">Checking access...</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="auth-message-shell">
        <p className="auth-message-text">Please Login Here</p>
        <Link href="/login" className="auth-message-link">
          Open Login
        </Link>
      </div>
    );
  }

  return <>{children}</>;
}
