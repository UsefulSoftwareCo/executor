import { dashboardHttpClient, hydratedResult } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { observeBrowserUsage } from "./product-analytics.ts";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  ApiKeyPage,
  CreatedApiKey,
  ApiKeyId,
  type CreateApiKey,
} from "@executor-js/hosted-server/api-keys";
import { sessionAtom } from "./auth.ts";
import { BrowserAtoms } from "./telemetry.ts";

/** Safe actionable lifecycle failures; raw HTTP responses never reach diagnostics. */
export class ApiKeyFailed extends Schema.TaggedError<ApiKeyFailed>()("ApiKeyFailed", {
  message: Schema.String,
}) {}
const request = <A>(
  operation: "list" | "create" | "delete",
  input: unknown,
  schema: Schema.ConstraintDecoder<A, never>,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const payload =
      operation === "list"
        ? HttpClientRequest.get(
            `/api/auth/api-key/list?limit=50&offset=${input}&sortBy=createdAt&sortDirection=desc`,
          )
        : yield* HttpClientRequest.bodyJson(
            HttpClientRequest.post(`/api/auth/api-key/${operation}`),
            input,
          );
    const response = yield* client.execute(payload);
    if (response.status !== 200)
      return yield* new ApiKeyFailed({
        message:
          response.status === 400
            ? "Check the key details and choose an expiry in the future."
            : response.status === 401
              ? "Your session expired. Sign in again."
              : response.status === 403
                ? "You no longer have permission to do that. Refresh this page."
                : response.status === 429
                  ? "Too many requests. Wait a minute and try again."
                  : operation === "create"
                    ? "Could not create the token. Refresh the list before trying again; a token may have been created."
                    : "Could not update tokens. Try again.",
      });
    return yield* Schema.decodeUnknownEffect(schema)(yield* response.json);
  }).pipe(
    Effect.catch((error) =>
      Effect.fail(
        error instanceof ApiKeyFailed
          ? error
          : new ApiKeyFailed({
              message:
                operation === "create"
                  ? "The response was lost. Refresh the list and revoke any token you could not copy before trying again."
                  : "Cannot reach the server. Try again.",
            }),
      ),
    ),
    (work) => observeBrowserUsage("api_keys", operation, work),
    Effect.provide(dashboardHttpClient),
  );

/** User-owned token metadata; session changes invalidate cached reads. */
const apiKeyPageAtom = Atom.family((offset: number) =>
  BrowserAtoms.atom((get) => {
    get(sessionAtom);
    return request("list", offset, ApiKeyPage);
  }).pipe(
    hydratedResult({ key: `hosted:api-keys:${offset}`, success: ApiKeyPage, error: ApiKeyFailed }),
  ),
);
export const apiKeysAtom = Atom.family((offset: number) =>
  Atom.readable(
    (get) =>
      AsyncResult.map(get(apiKeyPageAtom(offset)), (page) => ({
        ...page,
        apiKeys: page.apiKeys.map((key) => ({
          ...key,
          status: !key.enabled
            ? ("Disabled" as const)
            : key.expiresAt !== null && new Date(key.expiresAt).getTime() <= Date.now()
              ? ("Expired" as const)
              : ("Active" as const),
        })),
      })),
    (refresh) => refresh(apiKeyPageAtom(offset)),
  ).pipe(revalidated),
);
/** Creation returns a redacted token; the page keeps it only in the one-time copy dialog. */
export const createApiKeyAtom = BrowserAtoms.fn((input: typeof CreateApiKey.Type) =>
  request("create", input, CreatedApiKey),
);
/** Delete one of the current user's tokens through Better Auth. */
export const revokeApiKeyAtom = BrowserAtoms.fn((id: typeof ApiKeyId.Type) =>
  request("delete", { keyId: id }, Schema.Struct({ success: Schema.Boolean })),
);
