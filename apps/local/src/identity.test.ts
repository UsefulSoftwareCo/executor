import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { IdentityProvider } from "@executor-js/api/server";

import { LOCAL_PRINCIPAL, makeLocalIdentityLayer } from "./identity";

const TOKEN = "boot-token";

const authenticate = (path: string, headers: Record<string, string> = {}) =>
  Effect.flatMap(IdentityProvider.asEffect(), (provider) =>
    provider.authenticate(new Request(`http://127.0.0.1${path}`, { headers })),
  ).pipe(Effect.provide(makeLocalIdentityLayer(TOKEN)), Effect.exit, Effect.runPromise);

describe("makeLocalIdentityLayer", () => {
  it("resolves the local principal for a matching bearer token", async () => {
    const exit = await authenticate("/integrations", { authorization: `Bearer ${TOKEN}` });
    expect(exit).toStrictEqual(Exit.succeed(LOCAL_PRINCIPAL));
  });

  it("fails Unauthorized with no bearer token", async () => {
    const exit = await authenticate("/integrations");
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("fails Unauthorized with the wrong bearer token", async () => {
    const exit = await authenticate("/integrations", { authorization: "Bearer wrong" });
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("allows the OAuth callback without a bearer (state-gated)", async () => {
    // The Bun shell strips the `/api` prefix before this layer runs.
    const exit = await authenticate("/oauth/callback?state=abc");
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("still requires a bearer on the OAuth await poll", async () => {
    const exit = await authenticate("/oauth/await/session-1");
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
