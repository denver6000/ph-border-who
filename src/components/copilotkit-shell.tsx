"use client";

import { CopilotKit } from "@copilotkit/react-core";
import { CopilotSidebar } from "@copilotkit/react-ui";
import { useEffect, useState } from "react";

import { getFirebaseAppCheckToken, hasFirebaseAppCheckConfig } from "@/lib/firebase-app-check";

type CopilotKitShellProps = {
  appCheckDebugToken?: string | null;
  children: React.ReactNode;
};

export function CopilotKitShell({ appCheckDebugToken, children }: CopilotKitShellProps) {
  const [headers, setHeaders] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadHeaders() {
      if (!hasFirebaseAppCheckConfig()) {
        setHeaders({});
        return;
      }

      try {
        const token = await getFirebaseAppCheckToken({
          debugToken: appCheckDebugToken,
        });

        if (isMounted) {
          setHeaders({
            "X-Firebase-AppCheck": token,
          });
        }
      } catch {
        // Keep the assistant hidden if App Check cannot produce a token.
      }
    }

    loadHeaders();

    return () => {
      isMounted = false;
    };
  }, [appCheckDebugToken]);

  if (!headers) {
    return <>{children}</>;
  }

  return (
    <CopilotKit
      runtimeUrl="/api/copilotkit"
      agent="boundaryAssistant"
      headers={headers}
      showDevConsole={false}
    >
      {children}
      <CopilotSidebar
        labels={{
          title: "Boundary Assistant",
          initial: "Ask about city and barangay boundaries.",
          placeholder: "Ask about this map...",
        }}
      />
    </CopilotKit>
  );
}
