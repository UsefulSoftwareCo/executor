// The PRODUCTION self-host artifact as a target: the Docker image from
// apps/host-selfhost/Dockerfile (production Vite build, `bun src/serve.ts`,
// /data volume) instead of the dev server. Same surface as the selfhost
// target — same bootstrap admin, same Better Auth sign-in, same MCP consent —
// so the whole scenario suite runs against what users actually deploy. Boot
// lives in setup/selfhost-docker.globalsetup.ts.
import { Effect } from "effect";

import { e2ePort } from "../src/ports";
import type { Identity, Target } from "../src/target";
import { runSelfhostContainer, stopSelfhostContainer } from "../setup/selfhost-docker.boot";
import { forcedMcpConsent, SELFHOST_ADMIN, signInSession } from "./selfhost";

export const SELFHOST_DOCKER_PORT = e2ePort("E2E_SELFHOST_DOCKER_PORT", 5);
export const SELFHOST_DOCKER_BASE_URL =
  process.env.E2E_SELFHOST_DOCKER_URL ?? `http://localhost:${SELFHOST_DOCKER_PORT}`;

export const selfhostDockerTarget = (): Target => ({
  name: "selfhost-docker",
  baseUrl: SELFHOST_DOCKER_BASE_URL,
  mcpUrl: `${SELFHOST_DOCKER_BASE_URL}/mcp`,
  capabilities: new Set(["api", "browser", "mcp-oauth"]),
  newIdentity: () =>
    Effect.promise(async (): Promise<Identity> => {
      const { cookieHeader, cookies } = await signInSession(
        SELFHOST_DOCKER_BASE_URL,
        SELFHOST_ADMIN,
      );
      return {
        label: SELFHOST_ADMIN.email,
        credentials: SELFHOST_ADMIN,
        headers: { cookie: cookieHeader },
        cookies,
      };
    }),
  // Same forced-consent completion as the selfhost dev target: the app forces
  // `prompt=consent` on every MCP authorize, so authorize redirects to the
  // relative `/mcp-consent?consent_code=...` screen instead of straight to the
  // callback — mcporter's cookieConsentStrategy can't parse that redirect.
  mcpConsent: (identity: Identity) =>
    forcedMcpConsent(SELFHOST_DOCKER_BASE_URL, {
      email: identity.credentials?.email ?? SELFHOST_ADMIN.email,
      password: identity.credentials?.password || SELFHOST_ADMIN.password,
    }),
  // A real deployment cycle, not a warm `docker restart`: graceful stop
  // (SIGTERM + docker's grace), remove the container, start a NEW one from
  // the same image against the same data volume — what an upgrade, reboot,
  // or `compose down && up` does to a user's instance. Only when this suite
  // owns the container (attach mode can't assume the instance is docker).
  ...(process.env.E2E_SELFHOST_DOCKER_URL
    ? {}
    : {
        restart: () =>
          Effect.promise(async () => {
            // Published by the globalsetup after it resolved/built the image.
            const image = process.env.E2E_SELFHOST_DOCKER_RESOLVED_IMAGE;
            if (!image) throw new Error("selfhost-docker: no resolved image — boot ran?");
            await stopSelfhostContainer(SELFHOST_DOCKER_PORT);
            await runSelfhostContainer({
              image,
              port: SELFHOST_DOCKER_PORT,
              webBaseUrl: SELFHOST_DOCKER_BASE_URL,
              admin: SELFHOST_ADMIN,
            });
          }),
      }),
});
