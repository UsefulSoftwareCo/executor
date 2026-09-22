/** Decode the real browser transport at the external PostHog boundary. */
import type { Page } from "playwright";
import { driver, type DriverFailed } from "./platform.ts";
import { Effect, Schema } from "effect";

const Json = Schema.decodeUnknownSync(Schema.Json);
const inflate = (bytes: Uint8Array) =>
  new Response(
    new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream("gzip")),
  ).text();
const unpack = (value: Schema.Json): Effect.Effect<Schema.Json, DriverFailed> =>
  Effect.gen(function* () {
    if (typeof value === "string" && value.charCodeAt(0) === 31 && value.charCodeAt(1) === 139)
      return yield* unpack(
        Json(
          JSON.parse(
            yield* driver("inflate snapshot", () =>
              inflate(Uint8Array.from(value, (char) => char.charCodeAt(0))),
            ),
          ),
        ),
      );
    if (Array.isArray(value)) return yield* Effect.forEach(value, unpack);
    if (value !== null && typeof value === "object") {
      const result: { [key: string]: Schema.Json } = {};
      for (const [key, item] of Object.entries(value)) result[key] = yield* unpack(item);
      return result;
    }
    return value;
  });
/** Intercept only the synthetic ingestion path; real SDK recorder code runs in the product page. */
export const captureBrowserAnalytics = (page: Page) => {
  const events: Schema.Json[] = [];
  const failures: string[] = [];
  const requests: string[] = [];
  return page
    .route("**/api/0123456789abcdef/**", (route) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const request = route.request();
          const path = new URL(request.url()).pathname;
          requests.push(path);
          if (path.endsWith("/config.js")) {
            yield* driver("respond with public SDK configuration", () =>
              route.fulfill({
                contentType: "application/javascript",
                body: 'window._POSTHOG_REMOTE_CONFIG = {"synthetic-ingestion-key": {config: {hasFeatureFlags: false, sessionRecording: {endpoint: "/s/", sampleRate: 1, minimumDurationMilliseconds: 0}}}};',
              }),
            );
            return;
          }
          if (path.includes("/static/")) {
            const name = path.split("/").pop()?.split(".")[0];
            if (!["lazy-recorder", "recorder", "recorder-v2"].includes(name ?? "")) {
              yield* driver("respond to ingestion", () =>
                route.fulfill({ status: 404, body: "Unknown test asset" }),
              );
              return;
            }
            yield* driver("respond to ingestion", () =>
              route.fulfill({
                path: `apps/hosted/cloud/web/node_modules/posthog-js/dist/${name}.js`,
                contentType: "application/javascript",
              }),
            );
            return;
          }
          if (path.includes("/flags") || path.includes("/decide") || path.includes("/array/")) {
            yield* driver("respond to ingestion", () =>
              route.fulfill({
                json: {
                  featureFlags: {},
                  sessionRecording: {
                    endpoint: "/s/",
                    sampleRate: 1,
                    minimumDurationMilliseconds: 0,
                  },
                  supportedCompression: [],
                },
              }),
            );
            return;
          }
          const bytes = request.postDataBuffer();
          if (bytes) {
            try {
              const payload =
                bytes[0] === 31 && bytes[1] === 139
                  ? yield* driver("inflate browser batch", () => inflate(bytes))
                  : bytes.toString();
              const parsed = Json(JSON.parse(payload));
              events.push(
                ...(Array.isArray(parsed)
                  ? yield* Effect.forEach(parsed, unpack)
                  : [yield* unpack(parsed)]),
              );
            } catch {
              failures.push(path);
            }
          }
          yield* driver("respond to ingestion", () => route.fulfill({ json: { status: 1 } }));
        }),
      ),
    )
    .then(() => ({ events, failures, requests }));
};
