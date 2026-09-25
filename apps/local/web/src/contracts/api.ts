import { observeBrowserTransport, observeBrowserResponse } from "@executor-js/telemetry/browser";
import { DashboardRuntime } from "./telemetry.ts";
import { LocalAppManagementApi } from "@executor-js/local-server/app-management";
import { DashboardApi } from "@executor-js/local-server/contracts";
import type { AppId, DeploymentId, ProfileId } from "@executor-js/sdk";
import { Cause, Clock, Data, Effect, Option, Schedule, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClientError } from "effect/unstable/http";
import { AsyncResult, Atom, AtomHttpApi } from "effect/unstable/reactivity";
import { accountNeedsSignIn } from "./dashboard.ts";
import { acknowledgedQuery, currentQuery } from "@executor-js/ui/contracts/mutations";

/** The browser uses the same schemas and route definitions as the local product server. */
export class DashboardClient extends AtomHttpApi.Service<DashboardClient>()("DashboardClient", {
  api: DashboardApi.addHttpApi(LocalAppManagementApi),
  httpClient: FetchHttpClient.layer,
  runtime: DashboardRuntime,
  transformClient: observeBrowserTransport,
  transformResponse: observeBrowserResponse,
}) {}

/** An ended connection is resubscribed from current state, never treated as a completed query. */
export class LiveConnectionLost extends Schema.TaggedError<LiveConnectionLost>()(
  "LiveConnectionLost",
  {},
) {}

type Snapshot<A, E> =
  | { readonly type: "snapshot"; readonly revision: number; readonly value: A }
  | { readonly type: "failure"; readonly revision: number; readonly error: E }
  | { readonly type: "heartbeat" };

/** Own one subscription. Each restart emits Initial until its first fresh snapshot.
 * The outer Effect stream stays waiting throughout its lifetime; only frame state is query state. */
export const liveQueryAtom = <A, Q, E, E2>(
  query: Effect.Effect<Stream.Stream<Snapshot<A, Q>, E>, E2, DashboardClient>,
) =>
  DashboardClient.runtime
    .atom(
      Stream.concat(
        Stream.make(AsyncResult.initial<A, Q>(true)),
        Stream.unwrap(query).pipe(
          // Heartbeats detect half-open connections even when product data has not changed.
          Stream.timeout("45 seconds"),
          Stream.concat(Stream.fail(new LiveConnectionLost())),
          Stream.retry(
            Schedule.spaced("1 second").pipe(
              Schedule.while(
                ({ input }) =>
                  HttpClientError.isHttpClientError(input) ||
                  Cause.isTimeoutError(input) ||
                  Schema.is(LiveConnectionLost)(input),
              ),
            ),
          ),
          Stream.filter(
            (frame): frame is Exclude<Snapshot<A, Q>, { type: "heartbeat" }> =>
              frame.type !== "heartbeat",
          ),
          Stream.map((frame): AsyncResult.AsyncResult<A, Q> =>
            frame.type === "snapshot"
              ? AsyncResult.success(frame.value)
              : AsyncResult.fail(frame.error),
          ),
        ),
      ),
    )
    .pipe(
      Atom.map(
        (
          result,
        ): AsyncResult.AsyncResult<
          A,
          Q | E | E2 | LiveConnectionLost | Cause.NoSuchElementError
        > =>
          AsyncResult.isSuccess(result)
            ? result.value
            : AsyncResult.isFailure(result)
              ? AsyncResult.failure(result.cause)
              : AsyncResult.initial(result.waiting),
      ),
    );

/** The inventory updates from committed storage changes, including writes made through MCP and the SDK. */
const liveOverviewAtom = liveQueryAtom(
  Effect.flatMap(DashboardClient, (client) => client.dashboard.liveOverview()),
);

/** Repaint at the next known expiry without polling the server or loading every app's tools. */
export const overviewAtom = acknowledgedQuery(
  Atom.readable(
    (get) => {
      const result = get(liveOverviewAtom);
      const data = AsyncResult.value(result);
      const now = Effect.runSync(Clock.currentTimeMillis);
      if (Option.isSome(data)) {
        const deadlines = data.value.accounts.flatMap((account) =>
          account.signIn.state === "saved" &&
          account.signIn.reconnectAt !== null &&
          account.signIn.reconnectAt.getTime() > now
            ? [account.signIn.reconnectAt.getTime()]
            : [],
        );
        if (deadlines.length > 0)
          get.addFinalizer(
            Effect.runCallback(
              Effect.sleep(Math.min(Math.min(...deadlines) - now, 2_147_483_647)).pipe(
                Effect.andThen(Effect.sync(() => get.refreshSelf())),
              ),
            ),
          );
      }
      return AsyncResult.map(result, (data) => ({
        ...data,
        accounts: data.accounts.map((account) =>
          accountNeedsSignIn(account, now)
            ? { ...account, signIn: { state: "reconnect" as const } }
            : account,
        ),
      }));
    },
    (refresh) => refresh(liveOverviewAtom),
  ),
);

/** Follow current configuration and deployment activation while this app is mounted. */
export const appAtom = Atom.family((app: AppId) =>
  liveQueryAtom(
    Effect.flatMap(DashboardClient, (client) => client.dashboard.liveApp({ params: { app } })),
  ).pipe(acknowledgedQuery),
);

/** Immutable retained source follows the deployment selected by its live app atom. */
export const sourceAtom = Atom.family(
  (key: { readonly app: AppId; readonly deployment: DeploymentId }) =>
    DashboardClient.query("dashboard", "sourceDisplay", { params: key }),
);
class SourceFileKey extends Data.Class<{
  readonly app: AppId;
  readonly deployment: DeploymentId;
  readonly path: string;
}> {}
const sourceFileQuery = Atom.family((key: SourceFileKey) =>
  DashboardClient.query("dashboard", "sourceDisplayFile", {
    params: { app: key.app, deployment: key.deployment },
    query: { path: key.path },
  }).pipe(Atom.setIdleTTL("5 minutes")),
);
/** One display file of a retained deployment, read when the listing did not inline it. */
export const sourceFileAtom = (key: ConstructorParameters<typeof SourceFileKey>[0]) =>
  sourceFileQuery(new SourceFileKey(key));

/** Tool discovery reruns only when this app's execution inputs change. */
class ToolKey extends Data.Class<{
  readonly app: AppId;
  readonly profile?: ProfileId | undefined;
  readonly revision?: number | undefined;
  readonly deployment?: DeploymentId | null | undefined;
  readonly accounts?: string | undefined;
}> {}
const toolQueries = Atom.family((key: ToolKey) =>
  liveQueryAtom(
    Effect.flatMap(DashboardClient, (client) =>
      client.dashboard.liveTools({
        params: { app: key.app },
        query: { profile: key.profile, expectedProfileRevision: key.revision },
        sseOptions: { maxEventSize: 16 * 1024 * 1024 },
      }),
    ),
  ).pipe(currentQuery),
);

/** Catalog identities follow each tab's saved account selection. */
export const toolsAtom = (key: ConstructorParameters<typeof ToolKey>[0]) =>
  toolQueries(new ToolKey(key));

const toolLists = Atom.family((key: ToolKey) =>
  Atom.map(
    toolQueries(key),
    AsyncResult.map((page) => page.tools),
  ),
);
/** Shared browser view for the selected profile. */
export const toolListAtom = (key: ConstructorParameters<typeof ToolKey>[0]) =>
  toolLists(new ToolKey(key));
class ToolDetailKey extends Data.Class<
  ConstructorParameters<typeof ToolKey>[0] & { readonly tool: string }
> {}
const toolDetails = Atom.family(({ tool, ...key }: ToolDetailKey) =>
  Atom.map(
    toolLists(new ToolKey(key)),
    AsyncResult.map((tools) => tools.find((candidate) => candidate.name === tool)),
  ),
);
/** The live snapshot already carries schemas, so a selected tool reads from the same catalog. */
export const toolDetailAtom = (key: ConstructorParameters<typeof ToolDetailKey>[0]) =>
  toolDetails(new ToolDetailKey(key));
