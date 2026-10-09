/**
 * Real sign-in for synthetic agent identities on production or a deployed stage. Each identity is
 * `<name>@agents.executor.engineering`; its email codes and invitations arrive in the agent mail
 * stack. Nothing here bypasses the product's login, rate limits or authorization.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, Exit, FileSystem, Layer, Option, Path, References, Schema } from "effect";
import { CliError, Command, Flag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import {
  AgentMailUnavailable,
  agentAddress,
  agentMailbox,
} from "../cloud/scripts/agent-mailbox.ts";

class AgentSignInFailed extends Schema.TaggedError<AgentSignInFailed>()("AgentSignInFailed", {
  reason: Schema.String,
}) {}

/** Production and deployed stages only; local stacks use `hosted:test-account`. */
const HttpsOrigin = Schema.String.check(
  Schema.makeFilter((value) => URL.parse(value)?.origin === value && value.startsWith("https://"), {
    message: "Use an HTTPS origin without a path, such as https://v2.executor.sh",
  }),
);
const SignedIn = Schema.Struct({
  user: Schema.Struct({ id: Schema.String, email: Schema.String, name: Schema.String }),
});
const Organizations = Schema.Array(
  Schema.Struct({ id: Schema.String, slug: Schema.String, name: Schema.String }),
);
/** The file `sign-in` writes. `headers` works for every product request, including POSTs. */
const Session = Schema.Struct({
  origin: HttpsOrigin,
  email: Schema.String,
  headers: Schema.Struct({ cookie: Schema.String, origin: Schema.String }),
});

/** The account's current organizations, so callers have IDs for organization-targeted requests. */
const organizations = (origin: string, headers: typeof Session.Type.headers) =>
  Effect.gen(function* () {
    const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    return yield* http
      .get(`${origin}/api/auth/organization/list`, { headers })
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Organizations)));
  }).pipe(Effect.mapError(() => new AgentSignInFailed({ reason: "Could not list organizations" })));

const name = Flag.String("name").pipe(
  Flag.withDescription("Agent inbox name; the address is <name>@agents.executor.engineering"),
);

const signIn = Command.make("sign-in", {
  origin: Flag.String("origin").pipe(Flag.withSchema(HttpsOrigin)),
  name,
  output: Flag.String("output").pipe(
    Flag.withDescription("New private JSON file for session cookies; refuses to overwrite"),
  ),
}).pipe(
  Command.withDescription("Sign in or sign up through the real email-code flow"),
  Command.withHandler((args) =>
    Effect.scoped(
      Effect.gen(function* () {
        const email = yield* agentAddress(args.name);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const output = path.resolve(args.output);
        yield* fs.makeDirectory(path.dirname(output), { recursive: true, mode: 0o700 });
        const file = yield* fs.open(output, { flag: "wx", mode: 0o600 });
        yield* Effect.addFinalizer((exit) =>
          Exit.isFailure(exit) ? fs.remove(output).pipe(Effect.ignore) : Effect.void,
        );
        const mailbox = yield* agentMailbox;
        const http = yield* HttpClient.HttpClient;
        // Better Auth rejects cookie-less POSTs from a foreign origin.
        const post = (route: string, body: unknown) =>
          HttpClientRequest.post(`${args.origin}/api/auth${route}`).pipe(
            HttpClientRequest.setHeader("origin", args.origin),
            HttpClientRequest.bodyJsonUnsafe(body),
            http.execute,
          );
        const requestedAt = yield* mailbox.now;
        const sent = yield* post("/email-otp/send-verification-otp", { email, type: "sign-in" });
        if (sent.status !== 200)
          return yield* new AgentSignInFailed({ reason: `Code request returned ${sent.status}` });
        const message = yield* mailbox.waitFor(email, requestedAt, /sign-(in|up) code/i);
        const otp = /\b(\d{6})\b/.exec(message.text)?.[1];
        if (otp === undefined)
          return yield* new AgentSignInFailed({ reason: "The sign-in email had no code" });
        const response = yield* post("/sign-in/email-otp", { email, otp });
        if (response.status !== 200)
          return yield* new AgentSignInFailed({ reason: `Sign-in returned ${response.status}` });
        const signedIn = yield* HttpClientResponse.schemaBodyJson(SignedIn)(response);
        const cookie = response.headers["set-cookie"];
        const cookies = (Array.isArray(cookie) ? cookie : cookie === undefined ? [] : [cookie])
          .map((line) => line.split(";", 1)[0] ?? "")
          .filter((pair) => pair.includes("=") && !pair.endsWith("="));
        if (cookies.length === 0)
          return yield* new AgentSignInFailed({ reason: "Sign-in returned no session cookie" });
        const headers = { cookie: cookies.join("; "), origin: args.origin };
        const session = {
          origin: args.origin,
          email,
          userId: signedIn.user.id,
          name: signedIn.user.name,
          signedInAt: yield* mailbox.now,
          headers,
          organizations: yield* organizations(args.origin, headers),
        };
        yield* file.writeAll(new TextEncoder().encode(`${JSON.stringify(session, null, 2)}\n`));
        yield* Console.log(`Signed in as ${email}. Session saved to ${output}`);
      }),
    ),
  ),
);

const mail = Command.make("mail", {
  name,
  after: Flag.String("after").pipe(
    Flag.withDescription("Only messages received after this ISO time"),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Print an agent inbox, oldest first; includes invitation links"),
  Command.withHandler((args) =>
    Effect.gen(function* () {
      const address = yield* agentAddress(args.name);
      const mailbox = yield* agentMailbox;
      const messages = yield* mailbox.list(address, Option.getOrUndefined(args.after));
      yield* Console.log(
        JSON.stringify(
          messages.map(({ html: _html, ...message }) => message),
          null,
          2,
        ),
      );
    }),
  ),
);

const accept = Command.make("accept", {
  session: Flag.String("session").pipe(Flag.withDescription("Session file from sign-in")),
}).pipe(
  Command.withDescription("Accept the newest invitation in the session's inbox"),
  Command.withHandler((args) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const session = yield* fs.readFileString(args.session).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Session))),
        Effect.mapError(() => new AgentSignInFailed({ reason: "Unreadable session file" })),
      );
      const mailbox = yield* agentMailbox;
      const invitation = (yield* mailbox.list(session.email))
        .toReversed()
        .map((message) => /\/invite\?invitation=([^\s&]+)/.exec(message.text)?.[1])
        .find((id) => id !== undefined);
      if (invitation === undefined)
        return yield* new AgentSignInFailed({ reason: `No invitation for ${session.email}` });
      const http = yield* HttpClient.HttpClient;
      const response = yield* HttpClientRequest.post(
        `${session.origin}/api/auth/organization/accept-invitation`,
      ).pipe(
        HttpClientRequest.setHeaders(session.headers),
        HttpClientRequest.bodyJsonUnsafe({ invitationId: decodeURIComponent(invitation) }),
        http.execute,
      );
      if (response.status !== 200)
        return yield* new AgentSignInFailed({
          reason: `Accepting returned ${response.status}; sign in again if the session expired`,
        });
      yield* Console.log(
        JSON.stringify(yield* organizations(session.origin, session.headers), null, 2),
      );
    }),
  ),
);

NodeRuntime.runMain(
  Command.run(Command.make("agent-account").pipe(Command.withSubcommands([signIn, mail, accept])), {
    version: "0.0.0",
  }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    // Keep stdout machine-readable; Alchemy's state client logs its credential source at Info.
    Effect.provideService(References.MinimumLogLevel, "Warn"),
    Effect.catch((error) =>
      CliError.isCliError(error)
        ? Effect.fail(error)
        : Console.error(
            Schema.is(AgentSignInFailed)(error) || Schema.is(AgentMailUnavailable)(error)
              ? error.reason
              : "Agent account command failed. Load the Cloudflare credentials with bun run with:test-stage.",
          ).pipe(
            Effect.andThen(
              Effect.sync(() => {
                process.exitCode = 1;
              }),
            ),
          ),
    ),
  ),
);
