import { AppTopBar } from "@/components/app-top-bar";
import { AuthGuard } from "@/components/auth-guard";
import { FirebaseAppCheckBootstrap } from "@/components/firebase-app-check";

export default function ProtectedLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <AuthGuard>
      <FirebaseAppCheckBootstrap />
      <AppTopBar />
      <main className="app-main">{children}</main>
    </AuthGuard>
  );
}
