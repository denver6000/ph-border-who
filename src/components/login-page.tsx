"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { signInWithEmailAndPassword } from "firebase/auth";

import { useAuth } from "@/components/auth-provider";
import { PhilippinesOutlineIcon } from "@/components/philippines-outline-icon";
import { getFirebaseAuthClient } from "@/lib/firebase-client";

function GitHubIcon() {
  return (
    <svg
      aria-hidden="true"
      className="login-github-icon"
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M12 2C6.477 2 2 6.589 2 12.25c0 4.528 2.865 8.369 6.839 9.724.5.095.682-.223.682-.496 0-.244-.009-.891-.014-1.75-2.782.622-3.369-1.384-3.369-1.384-.455-1.183-1.11-1.498-1.11-1.498-.907-.639.069-.626.069-.626 1.002.072 1.529 1.053 1.529 1.053.89 1.562 2.336 1.111 2.905.85.091-.665.348-1.111.634-1.367-2.221-.261-4.555-1.14-4.555-5.074 0-1.121.39-2.038 1.029-2.756-.103-.262-.446-1.317.098-2.747 0 0 .84-.277 2.75 1.053A9.303 9.303 0 0 1 12 6.84c.85.004 1.706.118 2.504.348 1.909-1.33 2.748-1.053 2.748-1.053.546 1.43.203 2.485.1 2.747.64.718 1.027 1.635 1.027 2.756 0 3.944-2.338 4.81-4.566 5.066.358.316.677.939.677 1.892 0 1.367-.012 2.468-.012 2.804 0 .275.18.595.688.494C19.137 20.615 22 16.776 22 12.25 22 6.589 17.523 2 12 2Z" />
    </svg>
  );
}

function authErrorMessage(code: string | undefined) {
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Invalid email or password.";
    case "auth/too-many-requests":
      return "Too many login attempts. Try again later.";
    case "auth/network-request-failed":
      return "Network error while contacting Firebase Auth.";
    default:
      return "Login failed. Please try again.";
  }
}

export function LoginPage({ nextPath = "/" }: { nextPath?: string }) {
  const router = useRouter();
  const { hasAuthConfig, isLoading, user } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    if (!isLoading && user) {
      router.replace(nextPath);
    }
  }, [isLoading, nextPath, router, user]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage("");

    const auth = getFirebaseAuthClient();

    if (!auth) {
      setErrorMessage("Firebase Auth is not configured for this app.");
      return;
    }

    setIsSubmitting(true);

    try {
      await signInWithEmailAndPassword(auth, email, password);
      router.replace(nextPath);
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? String(error.code) : undefined;
      setErrorMessage(authErrorMessage(code));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="login-shell">
      <div className="login-background">
        <PhilippinesOutlineIcon />
      </div>
      <div className="login-panel">
        <p className="login-eyebrow">Please Login Here</p>
        <h1 className="login-title">Login to BORDER WHERE?</h1>
        <form className="login-form" onSubmit={handleSubmit}>
          <input
            autoComplete="email"
            className="login-input"
            name="email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Email"
            required
            type="email"
            value={email}
          />
          <input
            autoComplete="current-password"
            className="login-input"
            name="password"
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Password"
            required
            type="password"
            value={password}
          />
          <button className="login-button" disabled={isSubmitting || isLoading || !hasAuthConfig} type="submit">
            {isSubmitting ? "Logging in..." : "Login"}
          </button>
        </form>
        {errorMessage ? <p className="login-feedback">{errorMessage}</p> : null}
        {!hasAuthConfig ? <p className="login-feedback">Firebase Auth config is missing.</p> : null}
        <Link
          className="login-github-link"
          href="https://github.com/denver6000/ph-border-who"
          rel="noreferrer"
          target="_blank"
        >
          <GitHubIcon />
          <span>denver6000/ph-border-who</span>
        </Link>
      </div>
    </section>
  );
}
