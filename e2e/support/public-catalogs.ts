/**
 * The public catalogs self-host and local products read, served on loopback for a whole run: the
 * official app feed the Add app catalog lists, in the shape the integrations repository's
 * `scripts/feed.ts` writes, and the hosted Executor registry of published apps. Scenarios then
 * never depend on either live service. The feed holds synthetic apps: one with an API key, one with
 * OAuth beside a key, and one whose source names a different package than its listing. The
 * registry publishes nothing; registry-failures.spec.ts points a product at its own registry fixture.
 */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { appsVersion } from "./apps-release.ts";

const icon = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="${fill}"/></svg>`;

/** Icons are files beside the index; the index names them relative to itself. */
const catalogIcons: Readonly<Record<string, string>> = {
  "mail-light.svg": icon("#111111"),
  "mail-dark.svg": icon("#ffffff"),
  "tracker.svg": icon("#5e6ad2"),
};

const manifest = (name: string, title: string, description: string) => ({
  path: "package.json",
  content: `${JSON.stringify(
    {
      name,
      description,
      private: true,
      type: "module",
      dependencies: { apps: appsVersion },
      executor: { title },
    },
    null,
    2,
  )}\n`,
});

/** Synthetic official apps. Neither calls a service: listing and installing read only the feed. */
export const officialApps = {
  mail: {
    id: "synthetic-mail",
    package: "@executor.sh/synthetic-mail",
    name: "Synthetic Mail",
    description: "Send and read synthetic email.",
    auth: [{ method: "apiKey", kind: "secrets", label: "API key" }],
    category: "email",
    icons: [
      { src: "icons/mail-light.svg", mimeType: "image/svg+xml", theme: "light" },
      { src: "icons/mail-dark.svg", mimeType: "image/svg+xml", theme: "dark" },
    ],
    source: "apps/synthetic-mail.json",
  },
  tracker: {
    id: "synthetic-tracker",
    package: "@executor.sh/synthetic-tracker",
    name: "Synthetic Tracker",
    description: "Track synthetic issues.",
    auth: [
      { method: "oauth", kind: "oauth2" },
      { method: "token", kind: "secrets", label: "Personal token" },
    ],
    icons: [{ src: "icons/tracker.svg", mimeType: "image/svg+xml" }],
    source: "apps/synthetic-tracker.json",
  },
  mismatched: {
    id: "synthetic-mismatched",
    package: "@executor.sh/synthetic-mismatched",
    name: "Synthetic Mismatched",
    description: "A listing whose source names another package.",
    auth: [],
    icons: [],
    source: "apps/synthetic-mismatched.json",
  },
} as const;

const mailSource = `import { defineApp, defineProvider, object, query, router, secrets, string } from "apps";

const mail = defineProvider({
  name: "Synthetic Mail",
  auth: { apiKey: secrets({ label: "API key", fields: object({ token: string({ minLength: 1 }) }) }) },
});

export default defineApp({ user: { accounts: { mail: mail.many() } } }, async () => ({
  tools: router({
    inbox: query({ input: object({}), description: "List synthetic messages" }, async () => []),
  }),
}));
`;

const trackerSource = `import { defineApp, defineProvider, oauth2, object, query, router, secrets, string } from "apps";

const tracker = defineProvider({
  name: "Synthetic Tracker",
  auth: {
    oauth: oauth2({
      authorizationUrl: "https://tracker.example.test/oauth/authorize",
      tokenUrl: "https://tracker.example.test/oauth/token",
      scopes: ["read"],
    }),
    token: secrets({ label: "Personal token", fields: object({ token: string({ minLength: 1 }) }) }),
  },
});

export default defineApp({ user: { accounts: { tracker: tracker.many() } } }, async () => ({
  tools: router({
    issues: query({ input: object({}), description: "List synthetic issues" }, async () => []),
  }),
}));
`;

/** Each app's complete source, as the feed serves it. */
const catalogSources: Readonly<Record<string, unknown>> = {
  [officialApps.mail.source]: {
    package: officialApps.mail.package,
    files: [
      { path: "index.ts", content: mailSource },
      manifest(officialApps.mail.package, officialApps.mail.name, officialApps.mail.description),
    ],
  },
  [officialApps.tracker.source]: {
    package: officialApps.tracker.package,
    files: [
      { path: "index.ts", content: trackerSource },
      manifest(
        officialApps.tracker.package,
        officialApps.tracker.name,
        officialApps.tracker.description,
      ),
    ],
  },
  [officialApps.mismatched.source]: {
    package: officialApps.mismatched.package,
    files: [
      { path: "index.ts", content: mailSource },
      manifest("@executor.sh/another-app", "Another app", ""),
    ],
  },
};

/** Start the catalogs for the scope on loopback and return their origin. */
export const publicCatalogs = Effect.gen(function* () {
  const services = yield* Layer.build(
    HttpRouter.serve(
      Layer.mergeAll(
        HttpRouter.add(
          "GET",
          "/catalog/index.json",
          Effect.succeed(
            HttpServerResponse.jsonUnsafe({ version: 1, apps: Object.values(officialApps) }),
          ),
        ),
        HttpRouter.add(
          "GET",
          "/catalog/*",
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const path = new URL(request.url, "http://catalog").pathname.slice("/catalog/".length);
            const source = catalogSources[path];
            if (source !== undefined) return HttpServerResponse.jsonUnsafe(source);
            const svg = path.startsWith("icons/")
              ? catalogIcons[path.slice("icons/".length)]
              : undefined;
            return svg === undefined
              ? HttpServerResponse.empty({ status: 404 })
              : HttpServerResponse.text(svg, { contentType: "image/svg+xml" });
          }),
        ),
        HttpRouter.add(
          "GET",
          "/api/registry/apps",
          Effect.succeed(HttpServerResponse.jsonUnsafe([])),
        ),
        HttpRouter.add(
          "GET",
          "/api/registry/source",
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              { _tag: "RegistryError", reason: "not-found" },
              { status: 400 },
            ),
          ),
        ),
      ),
      { disableLogger: true, disableListenLog: true },
    ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("The catalogs must listen on TCP");
  return { origin: `http://127.0.0.1:${server.address.port}` };
});
