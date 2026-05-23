"use client";

import {
  createContext,
  startTransition,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { onAuthStateChanged, type User } from "firebase/auth";

import { getFirebaseAuthClient, hasFirebaseWebConfig } from "@/lib/firebase-client";

type AuthContextValue = {
  hasAuthConfig: boolean;
  isLoading: boolean;
  user: User | null;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const hasAuthConfig = hasFirebaseWebConfig();

  useEffect(() => {
    const auth = getFirebaseAuthClient();

    if (!auth) {
      startTransition(() => {
        setUser(null);
        setIsLoading(false);
      });
      return;
    }

    const unsubscribe = onAuthStateChanged(
      auth,
      (nextUser) => {
        startTransition(() => {
          setUser(nextUser);
          setIsLoading(false);
        });
      },
      () => {
        startTransition(() => {
          setUser(null);
          setIsLoading(false);
        });
      },
    );

    return unsubscribe;
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      hasAuthConfig,
      isLoading,
      user,
    }),
    [hasAuthConfig, isLoading, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);

  if (!value) {
    throw new Error("useAuth must be used within AuthProvider.");
  }

  return value;
}
