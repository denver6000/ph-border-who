import { AppTopBar } from "@/components/app-top-bar";
import { AuthGuard } from "@/components/auth-guard";

export default function ProtectedLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <AuthGuard>
      <AppTopBar />
      <main className="app-main">{children}</main>
    </AuthGuard>
  );
}
