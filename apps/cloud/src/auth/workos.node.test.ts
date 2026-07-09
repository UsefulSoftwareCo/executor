import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "@effect/vitest";
import { env } from "cloudflare:workers";
import { Effect, Schema } from "effect";
import { defaults as ironDefaults, seal as sealIron } from "iron-webcrypto";
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type JWK,
  type KeyLike,
} from "jose";

import { WorkOSClient, collectRawWorkOSList, collectWorkOSList } from "./workos";

const COOKIE_PASSWORD = "test_cookie_password_at_least_32_chars!";
const CLIENT_ID = "client_test";
const API_KEY = "sk_test";
const USER = {
  id: "user_test",
  email: "test@example.com",
  firstName: "Test",
  lastName: "User",
  profilePictureUrl: "https://example.com/avatar.png",
} as const;

interface Keypair {
  readonly kid: string;
  readonly publicJwk: JWK;
  readonly privateKey: KeyLike;
}

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

interface WorkOSStub {
  readonly baseUrl: string;
  readonly requests: () => readonly RecordedRequest[];
  readonly setKeys: (keys: ReadonlyArray<JWK>) => void;
}

const generateKeypair = async (kid: string): Promise<Keypair> => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  return { kid, publicJwk: { ...jwk, kid, alg: "RS256" }, privateKey };
};

const signAccessToken = (
  keypair: Keypair,
  claims: {
    readonly subject?: string;
    readonly organizationId?: string;
    readonly sessionId?: string;
    readonly expiresIn?: string | number;
  } = {},
) => {
  const jwt = new SignJWT({
    org_id: claims.organizationId ?? "org_test",
    sid: claims.sessionId ?? "session_test",
  })
    .setProtectedHeader({ alg: "RS256", kid: keypair.kid })
    .setSubject(claims.subject ?? USER.id)
    .setIssuedAt();

  return (
    typeof claims.expiresIn === "number"
      ? jwt.setExpirationTime(claims.expiresIn)
      : jwt.setExpirationTime(claims.expiresIn ?? "5m")
  ).sign(keypair.privateKey);
};

const sealSession = async (accessToken: string, refreshToken = "refresh_test"): Promise<string> =>
  `${await sealIron(
    {
      accessToken,
      refreshToken,
      user: USER,
    },
    { id: "1", secret: COOKIE_PASSWORD },
    { ...ironDefaults, ttl: 0, encode: JSON.stringify },
  )}~2`;

const workosUserResponse = {
  object: "user",
  id: USER.id,
  email: USER.email,
  email_verified: true,
  profile_picture_url: USER.profilePictureUrl,
  first_name: USER.firstName,
  last_name: USER.lastName,
  last_sign_in_at: null,
  locale: null,
  created_at: "2026-07-09T00:00:00.000Z",
  updated_at: "2026-07-09T00:00:00.000Z",
  external_id: null,
  metadata: {},
} as const;

const decodeJsonBody = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? decodeJsonBody(body) : null;
};

const writeJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const withWorkOSStub = async <A>(
  keypair: Keypair,
  use: (stub: WorkOSStub) => Promise<A>,
): Promise<A> => {
  let keys: ReadonlyArray<JWK> = [keypair.publicJwk];
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    // oxlint-disable-next-line executor/no-promise-catch -- boundary: Node's request callback cannot await, so the fixture converts async failures into a stable HTTP 500
    void (async () => {
      const path = request.url ?? "/";
      const body = request.method === "POST" ? await readJsonBody(request) : null;
      requests.push({ method: request.method ?? "GET", path, body });

      if (request.method === "GET" && path === `/sso/jwks/${CLIENT_ID}`) {
        writeJson(response, 200, { keys: keys.map((key) => ({ ...key })) } satisfies JSONWebKeySet);
        return;
      }

      if (request.method === "POST" && path === "/user_management/authenticate") {
        const refreshed = await signAccessToken(keypair, {
          sessionId: "session_refreshed",
        });
        writeJson(response, 200, {
          user: workosUserResponse,
          organization_id: "org_test",
          access_token: refreshed,
          refresh_token: "refresh_next",
          authentication_method: "Password",
        });
        return;
      }

      writeJson(response, 404, { error: "unexpected request" });
    })().catch((_error: unknown) => {
      writeJson(response, 500, {
        error: "fixture server failed",
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const stub: WorkOSStub = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests: () => requests,
    setKeys: (next) => {
      keys = next;
    },
  };

  return use(stub).finally(() => {
    server.closeAllConnections();
    server.close();
  });
};

const runAuthenticate = (sessionData: string, baseUrl: string) => {
  Object.assign(env, {
    WORKOS_API_KEY: API_KEY,
    WORKOS_CLIENT_ID: CLIENT_ID,
    WORKOS_COOKIE_PASSWORD: COOKIE_PASSWORD,
    WORKOS_API_URL: baseUrl,
  });

  return Effect.runPromise(
    Effect.gen(function* () {
      const workos = yield* WorkOSClient;
      return yield* workos.authenticateSealedSession(sessionData);
    }).pipe(Effect.provide(WorkOSClient.Default)),
  );
};

describe("authenticateSealedSession", () => {
  it("validates a sealed session locally with the cached JWKS", async () => {
    const keypair = await generateKeypair("k_valid");
    await withWorkOSStub(keypair, async (stub) => {
      const token = await signAccessToken(keypair, {
        organizationId: "org_test",
        sessionId: "session_valid",
      });
      const session = await sealSession(token);

      const result = await runAuthenticate(session, stub.baseUrl);

      expect(result).toEqual({
        userId: USER.id,
        email: USER.email,
        firstName: USER.firstName,
        lastName: USER.lastName,
        avatarUrl: USER.profilePictureUrl,
        organizationId: "org_test",
        sessionId: "session_valid",
        refreshedSession: undefined,
      });
      expect(stub.requests()).toEqual([
        { method: "GET", path: `/sso/jwks/${CLIENT_ID}`, body: null },
      ]);
    });
  });

  it("reuses the module cached JWKS for a second sealed session", async () => {
    const keypair = await generateKeypair("k_cached");
    await withWorkOSStub(keypair, async (stub) => {
      const first = await sealSession(
        await signAccessToken(keypair, {
          sessionId: "session_first",
        }),
      );
      const second = await sealSession(
        await signAccessToken(keypair, {
          sessionId: "session_second",
        }),
      );

      await runAuthenticate(first, stub.baseUrl);
      const afterFirst = stub.requests().length;
      const result = await runAuthenticate(second, stub.baseUrl);

      expect(afterFirst).toBe(1);
      expect(result?.sessionId).toBe("session_second");
      expect(stub.requests()).toEqual([
        { method: "GET", path: `/sso/jwks/${CLIENT_ID}`, body: null },
      ]);
    });
  });

  it("falls through to SDK refresh when the access token is expired", async () => {
    const keypair = await generateKeypair("k_expired");
    await withWorkOSStub(keypair, async (stub) => {
      const expiredAt = Math.floor(Date.now() / 1000) - 60;
      const expired = await signAccessToken(keypair, {
        expiresIn: expiredAt,
        sessionId: "session_expired",
      });
      const session = await sealSession(expired, "refresh_expired");

      const result = await runAuthenticate(session, stub.baseUrl);

      expect(result?.sessionId).toBe("session_refreshed");
      expect(result?.refreshedSession).toEqual(expect.any(String));
      expect(stub.requests().map((request) => [request.method, request.path])).toEqual([
        ["GET", `/sso/jwks/${CLIENT_ID}`],
        ["POST", "/user_management/authenticate"],
      ]);
      expect(stub.requests()[1]?.body).toMatchObject({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        client_secret: API_KEY,
        refresh_token: "refresh_expired",
        organization_id: "org_test",
      });
    });
  });

  it("returns null for garbage session data", async () => {
    const keypair = await generateKeypair("k_garbage");
    await withWorkOSStub(keypair, async (stub) => {
      const result = await runAuthenticate("not-a-sealed-session", stub.baseUrl);

      expect(result).toBeNull();
      expect(stub.requests()).toEqual([]);
    });
  });
});

describe("collectWorkOSList", () => {
  it("collects memberships beyond the first WorkOS page", async () => {
    const autoPaginationCalls: string[] = [];

    const response = await collectWorkOSList({
      object: "list",
      data: [{ id: "om_first_page" }],
      listMetadata: {
        before: null,
        after: "om_next_page",
      },
      autoPagination: async () => {
        autoPaginationCalls.push("called");
        return [{ id: "om_first_page" }, { id: "om_second_page" }];
      },
    });

    expect(response.data).toEqual([{ id: "om_first_page" }, { id: "om_second_page" }]);
    expect(response.listMetadata).toEqual({ before: null, after: null });
    expect(autoPaginationCalls).toEqual(["called"]);
  });

  it("keeps the first page when WorkOS reports no next page", async () => {
    let autoPaginationCalls = 0;

    const response = await collectWorkOSList({
      object: "list",
      data: [{ id: "om_only_page" }],
      listMetadata: {
        before: null,
        after: null,
      },
      autoPagination: async () => {
        autoPaginationCalls += 1;
        return [{ id: "om_unexpected_page" }];
      },
    });

    expect(response.data).toEqual([{ id: "om_only_page" }]);
    expect(response.listMetadata).toEqual({ before: null, after: null });
    expect(autoPaginationCalls).toBe(0);
  });
});

describe("collectRawWorkOSList", () => {
  it("collects raw WorkOS lists using snake-case cursors", async () => {
    const requestedCursors: Array<string | undefined> = [];

    const response = await collectRawWorkOSList(async (after) => {
      requestedCursors.push(after);
      return after
        ? {
            data: [{ id: "api_key_second_page" }],
            list_metadata: {
              before: null,
              after: null,
            },
          }
        : {
            data: [{ id: "api_key_first_page" }],
            list_metadata: {
              before: null,
              after: "api_key_second_page",
            },
          };
    });

    expect(response.data).toEqual([{ id: "api_key_first_page" }, { id: "api_key_second_page" }]);
    expect(response.listMetadata).toEqual({ before: null, after: null });
    expect(requestedCursors).toEqual([undefined, "api_key_second_page"]);
  });

  it("collects raw WorkOS lists using camel-case cursors", async () => {
    const response = await collectRawWorkOSList(async (after) =>
      after
        ? {
            data: [{ id: "second" }],
            listMetadata: {
              before: null,
              after: null,
            },
          }
        : {
            data: [{ id: "first" }],
            listMetadata: {
              before: null,
              after: "second",
            },
          },
    );

    expect(response.data).toEqual([{ id: "first" }, { id: "second" }]);
  });
});
