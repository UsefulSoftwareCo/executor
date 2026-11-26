import { Cause, Effect, FiberSet, FileSystem, Option, Path, Schema, Semaphore } from "effect";
import {
  type DesktopInstallLink,
  desktopInstallLink,
  desktopLinkProtocol,
  parseDesktopInstallLink,
} from "../../../../../packages/apps/src/contracts/desktop.ts";
import { AppUnavailable } from "../contracts/installed-apps.ts";
import type { InstalledApps } from "./installed-apps.ts";
import {
  type HostedServers,
  type HostedView,
  hostOf,
  identify,
  impersonation,
  type SignInExpectation,
  type SignInOutcome,
} from "./hosted-servers.ts";
import type { Prompt } from "./pages.ts";

const maximumWaiting = 4;
const localStartTimeout = "3 minutes";

class LinkRefused extends Schema.TaggedError<LinkRefused>()("LinkRefused", {
  message: Schema.String,
  detail: Schema.String,
}) {}

const refuse = (message: string, detail: string) => new LinkRefused({ message, detail });

export const isInstallLink = (value: string) => {
  const url = URL.parse(value);
  return url !== null && url.protocol === `${desktopLinkProtocol}:` && url.hostname === "install";
};

export const makeInstallLinks = (options: {
  readonly installedApps: InstalledApps;
  readonly hostedServers: HostedServers;
  readonly localRunning: () => boolean;
  readonly askToRunLocally: (message: string) => void;
  readonly prompt: (prompt: Prompt) => Effect.Effect<boolean>;
  readonly signIn: (
    origin: string,
    expected: SignInExpectation | undefined,
  ) => Effect.Effect<SignInOutcome>;
}) =>
  Effect.gen(function* () {
    const fork = yield* FiberSet.makeRuntime<FileSystem.FileSystem | Path.Path>();
    const lock = yield* Semaphore.make(1);
    const waiting = new Set<string>();
    const { installedApps, hostedServers } = options;

    const appName = (link: DesktopInstallLink) => link.name ?? "this app";

    const install = (account: string, link: DesktopInstallLink, host: string) =>
      installedApps.installFromLink(account, link.app).pipe(
        Effect.catchCause((cause) => {
          const reason = Option.filter(Cause.findErrorOption(cause), Schema.is(AppUnavailable));
          const name = appName(link);
          return Effect.fail(
            Option.isSome(reason) && reason.value.reason === "offline"
              ? refuse(
                  `Can't reach ${host}`,
                  `Executor could not reach ${host} to install ${name}. Check your connection, then open the link again.`,
                )
              : Option.isSome(reason) && reason.value.reason === "signed-out"
                ? refuse(
                    `Sign in again to install ${name}`,
                    `This computer's sign-in to ${host} ended. Open the link again to sign in.`,
                  )
                : refuse(
                    `${name === "this app" ? "This app" : name} isn't available`,
                    `${host} has no app with this link that you can open, or it has no page to open as an app. It may have been removed, or you may not have access to it.`,
                  ),
          );
        }),
      );

    const local = (link: DesktopInstallLink, serverId: string) =>
      Effect.gen(function* () {
        if (link.organization !== undefined)
          return yield* refuse(
            "Executor can't use this link",
            `${hostOf(link.server)} is an Executor on a computer, which has no teams, but the link names one.`,
          );
        if (!options.localRunning())
          return options.askToRunLocally(
            `A link asks to install ${appName(link)} from this computer's Executor. Run locally, then open the link again.`,
          );
        const localServer = yield* installedApps.localReady.pipe(
          Effect.timeoutOrElse({
            duration: localStartTimeout,
            orElse: () =>
              Effect.fail(
                refuse(
                  "Executor could not install this app",
                  "This computer's Executor did not start. Open the link again once it has.",
                ),
              ),
          }),
        );
        if (serverId !== localServer)
          return yield* refuse(
            "Executor can't install this app",
            `${hostOf(link.server)} is an Executor on another computer. Only this computer's Executor and the accounts you sign in to can install apps here.`,
          );
        yield* install(localServer, link, "this computer's Executor");
      });

    const signedInTo = (
      link: DesktopInstallLink,
      expected: SignInExpectation | undefined,
      organization: string,
    ) =>
      Effect.gen(function* () {
        const outcome = yield* options.signIn(link.server, expected);
        if (outcome.kind === "cancelled") return Option.none<string>();
        if (outcome.kind === "failed")
          return yield* refuse(`Executor did not install ${appName(link)}`, outcome.message);
        const account = hostedServers.accountOf(outcome.account);
        if (account === undefined || account.organizationId !== organization)
          return yield* refuse(
            `${appName(link)} is in another team`,
            `You signed in to ${account?.team ?? "another team"}, but ${appName(link)} is in ${link.team ?? "another team"}. Open the link again and choose ${link.team ?? "that team"} when you sign in.`,
          );
        return Option.some(outcome.account);
      });

    const hosted = (
      link: DesktopInstallLink,
      identity: { readonly serverId: string; readonly kind: string },
      organization: string,
    ) =>
      Effect.gen(function* () {
        const host = hostOf(link.server);
        const name = appName(link);
        const all = hostedServers.views().filter((view) => view.state !== "waiting");
        const problem = impersonation(identity, link.server, hostedServers.cloudOrigin, all);
        if (problem !== undefined)
          return yield* refuse(
            "Executor can't install this app",
            `${problem} Executor did not install ${name}.`,
          );
        const onServer = all.filter((view) => view.serverId === identity.serverId);
        const exact = onServer.find((view) => view.organizationId === organization);
        if (exact !== undefined && exact.state !== "sign-in-again")
          return yield* install(exact.id, link, host);
        if (!hostedServers.usable)
          return yield* refuse(
            "Executor could not install this app",
            "This computer's list of accounts could not be read, so Executor can't add one.",
          );
        const accepted = yield* options.prompt(
          exact !== undefined
            ? reauthentication(exact, name)
            : onServer.length > 0
              ? otherTeam(onServer, link, name)
              : firstSignIn(all, link, name, host),
        );
        if (!accepted) return;
        const account = yield* signedInTo(
          link,
          exact === undefined ? undefined : hostedServers.expectation(exact.id),
          organization,
        );
        if (Option.isNone(account)) return;
        yield* install(account.value, link, host);
      });

    const reauthentication = (account: HostedView, name: string): Prompt => ({
      title: `Sign in again to install ${name}`,
      body: [
        { text: "This computer's sign-in to " },
        { text: account.team, strong: true },
        { text: ` on ${account.host} ended. Sign in again and ${name} opens as an app here.` },
      ],
      app: name,
      team: account.team,
      accept: "Sign in again",
      dismiss: "Not now",
    });

    const otherTeam = (
      accounts: ReadonlyArray<HostedView>,
      link: DesktopInstallLink,
      name: string,
    ): Prompt => {
      const current = accounts[0]?.team ?? "another team";
      const team = link.team ?? "another team";
      return {
        title: `${name === "this app" ? "This app" : name} is in ${team}`,
        body: [
          { text: "You're signed in to " },
          { text: current, strong: true },
          { text: " on this computer. Sign in to " },
          { text: team, strong: true },
          { text: ` to install ${name}; ` },
          { text: current, strong: true },
          { text: " stays signed in." },
        ],
        app: name,
        team: link.team,
        accept: link.team === undefined ? "Sign in" : `Sign in to ${link.team}`,
        dismiss: "Not now",
      };
    };

    const firstSignIn = (
      accounts: ReadonlyArray<HostedView>,
      link: DesktopInstallLink,
      name: string,
      host: string,
    ): Prompt => {
      const cloud = link.server === hostedServers.cloudOrigin;
      const where = [
        { text: `${name === "this app" ? "This app" : name} is in ` },
        ...(link.team === undefined
          ? [{ text: "a team" }]
          : [{ text: "the " }, { text: link.team, strong: true }, { text: " team" }]),
        { text: " on " },
        { text: host, strong: true },
        { text: ". " },
      ];
      return {
        title: `Sign in to install ${name}`,
        body:
          accounts.length === 0
            ? [
                { text: "You're using Executor on this computer. " },
                ...where,
                {
                  text: `Sign in to ${cloud ? "Executor Cloud" : host} and it opens as an app here. Your local apps stay as they are.`,
                },
              ]
            : [...where, { text: "Sign in and it opens as an app here." }],
        app: name,
        team: link.team,
        accept: "Sign in",
        dismiss: "Not now",
      };
    };

    const handle = (link: DesktopInstallLink) =>
      Effect.gen(function* () {
        const identity = yield* identify(link.server).pipe(
          Effect.mapError(() =>
            refuse(
              "Executor can't install this app",
              `${hostOf(link.server)} did not answer as an Executor server.`,
            ),
          ),
        );
        if (identity.kind === "local") return yield* local(link, identity.serverId);
        if (link.organization === undefined)
          return yield* refuse(
            "Executor can't use this link",
            `${hostOf(link.server)} is a hosted Executor, and the link does not say which team the app is in.`,
          );
        return yield* hosted(link, identity, link.organization);
      });

    const explain = (cause: Cause.Cause<unknown>) =>
      Effect.gen(function* () {
        if (Cause.hasInterruptsOnly(cause)) return;
        const failure = Cause.findErrorOption(cause);
        const known = Option.filter(failure, Schema.is(LinkRefused));
        if (Option.isNone(known)) yield* Effect.logWarning("An install link failed", cause);
        else
          yield* Effect.logInfo("Refused an install link").pipe(
            Effect.annotateLogs({ reason: known.value.message }),
          );
        const shown = Option.getOrElse(known, () =>
          refuse(
            "Executor could not install this app",
            "Something went wrong. Try the link again.",
          ),
        );
        yield* options.prompt({
          title: shown.message,
          body: [{ text: shown.detail }],
          app: undefined,
          team: undefined,
          accept: undefined,
          dismiss: "OK",
        });
      });

    const open = (value: string) => {
      const link = parseDesktopInstallLink(value);
      const key = link === undefined ? value : (desktopInstallLink(link) ?? value);
      if (waiting.has(key)) return fork(Effect.logInfo("Ignored a repeated install link"));
      if (waiting.size >= maximumWaiting)
        return fork(Effect.logWarning("Ignored an install link while others wait"));
      waiting.add(key);
      fork(
        lock
          .withPermits(1)(
            (link === undefined
              ? Effect.fail(
                  refuse(
                    "Executor can't use this link",
                    "It is not a link to install an app from an Executor dashboard.",
                  ),
                )
              : handle(link)
            ).pipe(Effect.catchCause(explain)),
          )
          .pipe(Effect.ensuring(Effect.sync(() => waiting.delete(key)))),
      );
    };

    return { open };
  });
