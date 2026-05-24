import { AppTopBar } from "@/components/app-top-bar";
import { CopilotKitShell } from "@/components/copilotkit-shell";
import { FirebaseAppCheckBootstrap } from "@/components/firebase-app-check";

export default function ProtectedLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const appCheckDebugToken = process.env.APP_CHECK_DEBUG_TOKEN?.trim() || null;

  return (
    <>
      <FirebaseAppCheckBootstrap debugToken={appCheckDebugToken} />
      <CopilotKitShell appCheckDebugToken={appCheckDebugToken}>
        <AppTopBar />
        <main className="app-main">{children}</main>
      </CopilotKitShell>
    </>
  );
}
