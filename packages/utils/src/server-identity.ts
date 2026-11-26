import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";

export type ServerKind = "local" | "self-host" | "cloud";

export const serverIdentity = (kind: ServerKind, seed: string) =>
  Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(`executor-server:${kind}:${seed}`)),
  ).pipe(
    Effect.map((digest) => ({
      serverId: `${kind}-${Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("")}`,
      kind,
    })),
  );

export interface ServerOrigins {
  readonly dashboard: string;
  readonly api: string;
  readonly auth: string;
}

export const sameOrigins = (origin: string): ServerOrigins => ({
  dashboard: origin,
  api: origin,
  auth: origin,
});

export const publicIdentityCache = "public, max-age=300";

export const serverIdentityResponse = (
  identity: { readonly serverId: string; readonly kind: ServerKind },
  origins: ServerOrigins,
  cacheControl: typeof publicIdentityCache | "no-store",
) =>
  HttpServerResponse.jsonUnsafe(
    {
      serverId: identity.serverId,
      kind: identity.kind,
      origins: { dashboard: origins.dashboard, api: origins.api, auth: origins.auth },
    },
    {
      headers: {
        "cache-control": cacheControl,
        "x-content-type-options": "nosniff",
      },
    },
  );
