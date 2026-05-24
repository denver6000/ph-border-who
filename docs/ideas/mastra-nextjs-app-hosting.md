# Mastra Inside Next.js On Firebase App Hosting

## Core Idea

Mastra does not have to run as a separate backend process.

For this app, Mastra can live inside the Next.js codebase as server-side TypeScript. Next.js route handlers, server actions, or server components can import the Mastra instance directly and call agents, tools, or workflows.

That means Firebase App Hosting still sees one deployable Next.js app, while the app gets Mastra-powered AI features inside the same Cloud Run-backed backend.

## Why This Matters

The original concern was that Mastra might require a separate server process. That is still one valid deployment model, but it is not the only model.

Mastra supports two useful integration shapes with Next.js:

- Direct integration: Mastra code is bundled into the Next.js app and called from server-side Next.js code.
- Separate backend: Mastra runs as its own service, and Next.js talks to it using the Mastra client SDK.

For this project, direct integration is the better first move because the app is already deployed as one Firebase App Hosting backend.

## Recommended Shape For This App

Use one App Hosting backend:

```txt
Firebase App Hosting backend
  Next.js app
    src/app/api/.../route.ts
    src/mastra/index.ts
    src/mastra/agents/...
    src/mastra/tools/...
```

The Next.js API route becomes the HTTP boundary. Mastra remains an internal server-side module.

Example request flow:

```txt
Browser
  -> Next.js API route
    -> Mastra agent or workflow
      -> model provider / tools / Firestore
    <- response or stream
  <- API response
```

## Why Not Two Processes In One App Hosting Backend

Avoid trying to run both `next start` and a separate Mastra server process inside one App Hosting backend.

Firebase App Hosting builds one deployable app container and rolls it out to one Cloud Run service. Cloud Run has a single public ingress port for the service. Multiple internal processes can sometimes be made to work with a custom proxy, but it adds lifecycle, logging, health check, memory, and scaling complexity.

For this project, that extra complexity is not needed.

## When To Split Mastra Out Later

A separate Mastra backend becomes more attractive if:

- multiple frontends need to call the same AI backend
- a mobile app needs direct access to the same agent API
- Mastra needs to scale independently from the web app
- workflows become long-running or operationally distinct
- the team wants separate logs, deploys, auth boundaries, or ownership

If that happens, the likely deployment target should be Mastra Cloud or a separate Cloud Run service. A second App Hosting backend may work for a Node/Express-style server, but plain Cloud Run is the cleaner production fit for a standalone Mastra service.

## Init Command To Consider

Mastra's CLI supports adding Mastra to an existing project with `mastra init`.

For this repo, a conservative start would be:

```powershell
npx mastra@latest init --dir src --components agents,tools --llm google --no-example
```

If we want a small generated sample to learn from first:

```powershell
npx mastra@latest init --dir src --components agents,tools --llm google --example
```

After init, review the generated files before committing. The CLI may add dependencies and adjust TypeScript config.

## Next.js Config Note

Mastra packages may need to be kept external to Next.js server bundling because they can depend on Node-only runtime behavior.

If needed, update `next.config.ts`:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@mastra/*"],
};

export default nextConfig;
```

## App Hosting Notes

Current App Hosting config:

```txt
backendId: hdx-baranggay-boundary
minInstances: 0
maxInstances: 5
concurrency: 10
cpu: 1
memoryMiB: 512
```

Mastra model provider keys should be stored as App Hosting secrets, not committed to source.

Use Firebase CLI secret management for production keys:

```powershell
firebase apphosting:secrets:set GOOGLE_GENERATIVE_AI_API_KEY
```

Then reference the secret from `apphosting.yaml`.

## First Practical Integration Step

The smallest useful proof of concept:

1. Run `npx mastra@latest init` with the chosen options.
2. Add one simple Mastra agent.
3. Add one Next.js route handler under `src/app/api/ai/.../route.ts`.
4. Call the agent from that route.
5. Run `npm run build`.
6. Confirm Firebase App Hosting still deploys one Next.js app.

