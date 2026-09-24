import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { RUNS_DIR, scenario } from "../src/scenario";
import { RunDir, Target, Telemetry } from "../src/services";

const decodeString = Schema.decodeUnknownSync(Schema.String);

const decodeKey = Schema.decodeUnknownSync(
  Schema.Struct({ id: Schema.String, value: Schema.String }),
);

scenario(
  "Authentication · valid credentials work in headers but not query parameters",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const runDir = yield* RunDir;
    const identity = yield* target.newIdentity({ adminMfa: false });
    const keyResponse = yield* Effect.promise(() =>
      fetch(new URL("/api/account/api-keys", target.baseUrl), {
        method: "POST",
        headers: {
          ...identity.headers,
          origin: target.baseUrl,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "authentication-evidence" }),
      }),
    );
    expect(keyResponse.status).toBe(200);
    const key = decodeKey(yield* Effect.promise(() => keyResponse.json()));
    yield* Effect.promise(async () => {
      const cases: Array<{ surface: string; carrier: string; status: number }> = [];
      for (const surface of ["api", "mcp"]) {
        const send = async (query: string | null, header: boolean) => {
          const url = new URL(surface === "api" ? "/api/policies" : "/mcp", target.baseUrl);
          if (query) url.searchParams.set(query, key.value);
          const response = await fetch(url, {
            method: surface === "api" ? "GET" : "POST",
            headers: {
              accept: "application/json, text/event-stream",
              "content-type": "application/json",
              ...(header ? { authorization: `Bearer ${key.value}` } : {}),
            },
            ...(surface === "mcp"
              ? {
                  body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "initialize",
                    params: {
                      protocolVersion: "2025-03-26",
                      capabilities: {},
                      clientInfo: { name: "authentication-evidence", version: "1" },
                    },
                  }),
                }
              : {}),
          });
          await response.text();
          cases.push({
            surface,
            carrier: query ?? "Authorization header",
            status: response.status,
          });
          return response.status;
        };
        expect(await send(null, true), `${surface} accepts the valid header credential`).toBe(200);
        for (const query of [
          "api_key",
          "apikey",
          "key",
          "token",
          "access_token",
          "authorization",
        ]) {
          expect(await send(query, false), `${surface} rejects query-only ${query}`).toBe(
            surface === "api" ? 403 : 401,
          );
        }
      }
      await writeFile(
        join(runDir, "authentication-carriers.json"),
        JSON.stringify({ cases }, null, 2),
      );
    }).pipe(
      Effect.ensuring(
        Effect.promise(async () => {
          const response = await fetch(new URL(`/api/account/api-keys/${key.id}`, target.baseUrl), {
            method: "DELETE",
            headers: { ...identity.headers, origin: target.baseUrl },
          });
          expect(response.status, "the disposable key is revoked").toBe(200);
        }),
      ),
    );
  }),
);

scenario(
  "Authentication · successful login exports diagnostics without its credentials",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const telemetry = yield* Telemetry;
    const runDir = yield* RunDir;
    const identity = yield* target.newIdentity({ adminMfa: false });
    const bootLog = join(RUNS_DIR, "cloud", "server-logs", "boot.log");
    const initialLogLength = (yield* Effect.promise(() => readFile(bootLog, "utf8"))).length;
    const traceId = randomBytes(16).toString("hex");
    const headers = { traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01` };
    const credentials = yield* Effect.promise(async () => {
      const login = await fetch(new URL("/api/auth/login", target.baseUrl), { redirect: "manual" });
      expect(login.status).toBe(302);
      const authorize = new URL(decodeString(login.headers.get("location")));
      const state = decodeString(authorize.searchParams.get("state"));
      const stateCookie = login.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith("wos-login-state="));
      expect(stateCookie !== undefined).toBe(true);
      authorize.searchParams.set("login_hint", identity.label);
      const consent = await fetch(authorize, { redirect: "manual" });
      expect(consent.status).toBe(302);
      const callback = new URL(decodeString(consent.headers.get("location")));
      const code = decodeString(callback.searchParams.get("code"));
      const signedIn = await fetch(callback, {
        redirect: "manual",
        headers: {
          ...headers,
          cookie: decodeString(stateCookie).split(";")[0] ?? "",
        },
      });
      expect(signedIn.status).toBe(302);
      const session = signedIn.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith("wos-session="));
      const sessionPair = decodeString(session).split(";")[0] ?? "";
      const verified = await fetch(new URL("/api/auth/me", target.baseUrl), {
        headers: { cookie: sessionPair },
      });
      expect(verified.status).toBe(200);
      return [state, code, sessionPair.slice("wos-session=".length)];
    });
    yield* telemetry.expectSpan({ traceId });
    const spans = yield* telemetry.searchSpans({ traceId });
    const exported = JSON.stringify(spans);
    const logs = (yield* Effect.promise(() => readFile(bootLog, "utf8"))).slice(initialLogLength);
    const matches = credentials.map((credential) => ({
      trace: exported.includes(credential),
      serverLog: logs.includes(credential),
    }));
    // Assert booleans so even a failure cannot print a credential.
    expect(matches.every((match) => !match.trace && !match.serverLog)).toBe(true);
    yield* Effect.promise(() =>
      writeFile(
        join(runDir, "login-diagnostics.json"),
        JSON.stringify(
          {
            environment: "isolated cloud Worker with WorkOS emulator",
            loginStatus: 302,
            authenticatedSessionStatus: 200,
            traceId,
            exportedSpanCount: spans.length,
            checkedCredentials: ["OAuth state", "authorization code", "sealed session cookie"],
            credentialMatches: matches,
            sample: spans.map(({ span }) => ({
              operation: span.operationName,
              status: span.status,
              attributeNames: Object.keys(span.tags),
            })),
          },
          null,
          2,
        ),
      ),
    );
  }),
);
