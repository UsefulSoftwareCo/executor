/** GitHub lifecycle discovery and live verification; Alchemy owns provisioning and comments. */
import { Config, Console, Effect, FileSystem, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
  PreviewCommit,
  PreviewNumber,
  previewBrowserOrigin,
  previewOrigin,
  previewOwner,
  previewRepository,
  previewSlug,
} from "../contracts/pr-preview.ts";
import { TestStageFailed } from "../contracts/test-stage-lifetime.ts";
import { withStageAdmin } from "./test-stage-inventory.ts";

const number = Argument.Int("number").pipe(Argument.withSchema(PreviewNumber));
const PullRequest = Schema.Struct({
  state: Schema.Literals(["open", "closed"]),
  head: Schema.Struct({
    sha: PreviewCommit,
    ref: Schema.String,
    repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
  }),
});
const StackedAbove = Schema.Array(
  Schema.Struct({
    number: PreviewNumber,
    head: Schema.Struct({ repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })) }),
  }),
);
const pullRequest = (repository: string, number: number) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const json = yield* spawner.string(
      ChildProcess.make("gh", ["api", `repos/${repository}/pulls/${number}`]),
    );
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PullRequest))(json);
  });
/** Only the top layer of a stack is previewed; it contains every lower layer's change. */
const isStackedUnder = (repository: string, ref: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const json = yield* spawner.string(
      ChildProcess.make("gh", [
        "api",
        "--method",
        "GET",
        `repos/${repository}/pulls`,
        "-f",
        "state=open",
        "-f",
        `base=${ref}`,
        "-f",
        "per_page=100",
      ]),
    );
    const above = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StackedAbove))(json);
    // Fork PRs never get a preview, so they cannot stand in for this one.
    return above.some((pr) => pr.head.repo?.full_name === repository);
  });
const previewAction = (repository: string, number: number) =>
  Effect.gen(function* () {
    const pr = yield* pullRequest(repository, number);
    if (pr.state === "closed") return { pr, action: "destroy" as const };
    return {
      pr,
      action: (yield* isStackedUnder(repository, pr.head.ref))
        ? ("retire" as const)
        : ("deploy" as const),
    };
  });
const output = (values: Record<string, string>) =>
  Effect.gen(function* () {
    const path = yield* Config.String("GITHUB_OUTPUT");
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      path,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
      { flag: "a" },
    );
  });
const prepare = Command.make("prepare", { number }, ({ number }) =>
  Effect.gen(function* () {
    const repository = yield* previewRepository;
    const { pr, action } = yield* previewAction(repository, number);
    if (pr.head.repo?.full_name !== repository)
      return yield* new TestStageFailed({ message: "Fork PRs cannot access preview credentials." });
    yield* output({
      action,
      sha: pr.head.sha,
      slug: previewSlug(number),
      owner: previewOwner(repository, number),
      url: previewOrigin(number),
    });
  }),
);
const guard = Command.make("guard", { number }, ({ number }) =>
  Effect.gen(function* () {
    const repository = yield* previewRepository;
    const lease = yield* withStageAdmin((admin) => admin.get(previewSlug(number)));
    if (lease !== undefined && lease.owner !== previewOwner(repository, number))
      return yield* new TestStageFailed({
        message: "This stage belongs to another preview owner.",
      });
    yield* output({ exists: lease === undefined ? "false" : "true" });
  }),
);
/** Retained previews whose PR closed or now has another layer stacked above it. */
const stale = Command.make("stale", {}, () =>
  Effect.gen(function* () {
    const repository = yield* previewRepository;
    const stages = yield* withStageAdmin((admin) => admin.list);
    const numbers: number[] = [];
    for (const stage of stages) {
      const match = /^pr-([1-9][0-9]*)$/.exec(stage.slug);
      if (match === null) continue;
      const number = yield* Schema.decodeUnknownEffect(PreviewNumber)(Number(match[1]));
      if (stage.owner !== previewOwner(repository, number)) continue;
      if ((yield* previewAction(repository, number)).action !== "deploy") numbers.push(number);
    }
    yield* output({ numbers: JSON.stringify(numbers) });
    yield* Console.log(`Found ${numbers.length} stale PR preview(s) to clean up.`);
  }),
);
const verify = Command.make("verify", { number }, ({ number }) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const deployment = previewOrigin(number);
    // Health is the deployment's; sign-in, its pages and its session are on the browser origin.
    const origin = previewBrowserOrigin(number);
    for (const path of ["/health", "/login", "/api/auth/get-session"]) {
      const response = yield* client.get(`${path === "/health" ? deployment : origin}${path}`);
      if (response.status !== 200)
        return yield* new TestStageFailed({
          message: `Preview ${path} returned HTTP ${response.status}.`,
        });
      if (path === "/health")
        yield* response.json.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.Struct({ status: Schema.Literal("ok") })),
          ),
        );
      else if (path === "/api/auth/get-session")
        yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Null)));
      else {
        const html = yield* response.text;
        const paths = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.NonEmptyString))(
          [...html.matchAll(/(?:src|href)="([^" ]+\.(?:js|css))"/g)].map((match) => match[1]),
        );
        const assets = paths
          .map((path) => new URL(path, origin))
          .filter((asset) => asset.origin === origin);
        if (assets.length === 0)
          return yield* new TestStageFailed({
            message: "Preview login did not include application assets.",
          });
        for (const asset of assets) {
          const response = yield* client.get(asset.href);
          const type = response.headers["content-type"];
          if (
            response.status !== 200 ||
            type === undefined ||
            !(asset.pathname.endsWith(".css")
              ? type.includes("text/css")
              : type.includes("javascript"))
          )
            return yield* new TestStageFailed({
              message: "A preview login asset could not be loaded.",
            });
          yield* response.text;
        }
      }
    }
    // Starting both real social flows catches missing proxy/client settings. This does not claim
    // the identity provider's callback was completed, and sends no email or login credentials.
    const proxy = yield* Config.NonEmptyString("OAUTH_PROXY_PRODUCTION_URL");
    for (const provider of ["google", "github"]) {
      const request = yield* HttpClientRequest.post(`${origin}/api/auth/sign-in/social`, {
        headers: { origin },
      }).pipe(
        HttpClientRequest.bodyJson({ provider, callbackURL: `${origin}/`, disableRedirect: true }),
      );
      const response = yield* client.execute(request);
      if (response.status !== 200)
        return yield* new TestStageFailed({
          message: `Preview ${provider} sign-in could not start.`,
        });
      const body = yield* response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ url: Schema.String }))),
      );
      const url = yield* Effect.try({
        try: () => new URL(body.url),
        catch: () =>
          new TestStageFailed({ message: "Sign-in did not return a valid authorization URL." }),
      });
      if (
        url.protocol !== "https:" ||
        url.hostname !== (provider === "google" ? "accounts.google.com" : "github.com") ||
        url.searchParams.get("redirect_uri") !== `${proxy}/api/auth/callback/${provider}`
      )
        return yield* new TestStageFailed({
          message: "Sign-in did not reach the expected identity provider.",
        });
    }
    yield* Console.log(
      `Verified preview health, login, assets, session and social sign-in redirects: ${deployment}`,
    );
  }).pipe(
    // The message names the request's method and public preview URL, such as a TLS handshake
    // that failed on a role host.
    Effect.catchTag("HttpClientError", (error) =>
      Effect.fail(new TestStageFailed({ message: `Preview request failed: ${error.message}` })),
    ),
    Effect.timeout("2 minutes"),
  ),
);

/** Called from workflows with step-scoped GitHub and staging credentials. */
export const prPreviewCommand = Command.make("pr-preview").pipe(
  Command.withSubcommands([prepare, guard, stale, verify]),
);
