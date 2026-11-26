import { dashboardHttpClient, hydrated, requestKey } from "@executor-js/ui/contracts/http";
import { observeBrowserTransport, observeBrowserResponse } from "@executor-js/telemetry/browser";
import { observeBuild } from "@executor-js/dashboard-start/build-change";
import { BrowserAtoms, DashboardRuntime } from "./telemetry.ts";
import { toolRunApproval } from "@executor-js/ui/contracts/browser-approval";
import { LocalAppManagementApi } from "@executor-js/local-server/app-management";
import {
  DashboardApi,
  DashboardApp,
  DashboardOverview,
  DashboardTools,
} from "@executor-js/local-server/contracts";
import type { AppId, ApprovalRequestId, VersionId, Json, ToolName } from "@executor-js/sdk";
import { Cause, Clock, Data, Effect, Option, Schedule, Schema, Stream } from "effect";
import { HttpClientError } from "effect/http";
import { AsyncResult, Atom, AtomHttpApi } from "effect/reactivity";
import { accountNeedsSignIn } from "./dashboard.ts";
import { acknowledgedQuery, currentQuery } from "@executor-js/ui/contracts/mutations";
import { refreshedOnFocus } from "@executor-js/ui/contracts/refresh";

export class DashboardClient extends AtomHttpApi.Service<DashboardClient>()("DashboardClient", {
  api: DashboardApi.addHttpApi(LocalAppManagementApi),
  httpClient: dashboardHttpClient,
  runtime: DashboardRuntime,
  transformClient: (client) => observeBrowserTransport(observeBuild(client)),
  transformResponse: observeBrowserResponse,
}) {}

export class LiveConnectionLost extends Schema.TaggedError<LiveConnectionLost>()(
  "LiveConnectionLost",
  {},
) {}

type Snapshot<A, E> =
  | { readonly type: "snapshot"; readonly revision: number; readonly value: A }
  | { readonly type: "failure"; readonly revision: number; readonly error: E }
  | { readonly type: "heartbeat" };

const liveStreamAtom = <A, Q, E, E2>(
  query: Effect.Effect<Stream.Stream<Snapshot<A, Q>, E>, E2, DashboardClient>,
) =>
  DashboardClient.runtime
    .atom(
      Stream.concat(
        Stream.make(AsyncResult.initial<A, Q>(true)),
        Stream.unwrap(query).pipe(
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

const pageSnapshots = new WeakSet<AsyncResult.AsyncResult<unknown, unknown>>();

export const liveQueryAtom = <A, I, Q, E, E2>(options: {
  readonly name: string;
  readonly key: object;
  readonly success: Schema.Codec<A, I>;
  readonly query: Effect.Effect<Stream.Stream<Snapshot<A, Q>, E>, E2, DashboardClient>;
}) => {
  const live = liveStreamAtom(options.query);
  const rendered = Atom.readable((get) => AsyncResult.value(get(live))).pipe(
    Atom.serializable({
      key: `local:live:${options.name}:${requestKey(options.key)}`,
      schema: Schema.Option(options.success),
    }),
  );
  return Atom.readable(
    (get): Atom.Type<typeof live> => {
      const result = get(live);
      const snapshot = get(rendered);
      const previous = get.self<Atom.Type<typeof live>>();
      const following = Option.isSome(previous) && !pageSnapshots.has(previous.value);
      if (following || !AsyncResult.isInitial(result) || Option.isNone(snapshot)) return result;
      const shown = AsyncResult.success(snapshot.value);
      pageSnapshots.add(shown);
      return shown;
    },
    (refresh) => {
      refresh(live);
      refresh(rendered);
    },
  );
};

const liveOverviewAtom = liveQueryAtom({
  name: "overview",
  key: {},
  success: DashboardOverview,
  query: Effect.flatMap(DashboardClient, (client) => client.dashboard.liveOverview()),
});

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

export const appAtom = Atom.family((app: AppId) =>
  liveQueryAtom({
    name: "app",
    key: { app },
    success: DashboardApp,
    query: Effect.flatMap(DashboardClient, (client) =>
      client.dashboard.liveApp({ params: { app } }),
    ),
  }).pipe(acknowledgedQuery),
);

export const sourceAtom = Atom.family((key: { readonly app: AppId; readonly version: VersionId }) =>
  DashboardClient.query("dashboard", "sourceDisplay", hydrated({ params: key })),
);
class SourceFileKey extends Data.Class<{
  readonly app: AppId;
  readonly version: VersionId;
  readonly path: string;
}> {}
const sourceFileQuery = Atom.family((key: SourceFileKey) =>
  DashboardClient.query(
    "dashboard",
    "sourceDisplayFile",
    hydrated({
      params: { app: key.app, version: key.version },
      query: { path: key.path },
    }),
  ).pipe(Atom.setIdleTTL("5 minutes")),
);
export const sourceFileAtom = (key: ConstructorParameters<typeof SourceFileKey>[0]) =>
  sourceFileQuery(new SourceFileKey(key));

class ToolKey extends Data.Class<{
  readonly app: AppId;
  readonly version?: VersionId | null | undefined;
}> {}
const toolQueries = Atom.family((key: ToolKey) =>
  liveQueryAtom({
    name: "tools",
    key: { app: key.app, version: key.version },
    success: DashboardTools,
    query: Effect.flatMap(DashboardClient, (client) =>
      client.dashboard.liveTools({
        params: { app: key.app },
        sseOptions: { maxEventSize: 16 * 1024 * 1024 },
      }),
    ),
  }).pipe(refreshedOnFocus, currentQuery),
);

export const toolsAtom = (key: ConstructorParameters<typeof ToolKey>[0]) =>
  toolQueries(new ToolKey(key));

const toolLists = Atom.family((key: ToolKey) =>
  Atom.map(
    toolQueries(key),
    AsyncResult.map((page) => page.tools),
  ),
);
export const toolListAtom = (key: ConstructorParameters<typeof ToolKey>[0]) =>
  toolLists(new ToolKey(key));
export const toolCatalogAtom = (key: ConstructorParameters<typeof ToolKey>[0]) =>
  toolQueries(new ToolKey(key));
class ToolDetailKey extends Data.Class<
  ConstructorParameters<typeof ToolKey>[0] & { readonly tool: string }
> {}
class ToolSchemaKey extends Data.Class<{
  readonly app: AppId;
  readonly tool: ToolName;
  readonly version: VersionId;
}> {}
const toolSchemaQueries = Atom.family(({ app, tool, version }: ToolSchemaKey) =>
  DashboardClient.query(
    "dashboard",
    "tool",
    hydrated({ params: { app, tool }, query: { version } }),
  ),
);
const listedToolSchemas = Atom.family(({ tool, ...key }: ToolDetailKey) =>
  Atom.readable((get) => {
    const listed = get(toolLists(new ToolKey(key)));
    const query = AsyncResult.map(listed, (tools) => {
      const summary = tools.find((candidate) => candidate.name === tool);
      return summary === undefined
        ? undefined
        : toolSchemaQueries(
            new ToolSchemaKey({ app: key.app, tool: summary.name, version: summary.version }),
          );
    });
    const previous = get.self<typeof query>();
    if (
      AsyncResult.isSuccess(query) &&
      query.value !== undefined &&
      Option.exists(previous, AsyncResult.isSuccess)
    )
      get.refresh(query.value);
    return query;
  }),
);
const toolDetails = Atom.family((key: ToolDetailKey) =>
  DashboardClient.runtime.atom((get) =>
    Effect.gen(function* () {
      const query = yield* get.result(listedToolSchemas(key));
      if (query === undefined) return undefined;
      return yield* get
        .result(query)
        .pipe(Effect.catchTag("ToolNotFound", () => Effect.succeed(undefined)));
    }),
  ),
);
export const toolDetailAtom = (key: ConstructorParameters<typeof ToolDetailKey>[0]) =>
  toolDetails(new ToolDetailKey(key));

class CallKey extends Data.Class<{
  readonly app: AppId;
  readonly version?: VersionId | undefined;
  readonly tool: ToolName;
  readonly kind: "query" | "mutation";
}> {}
const calls = Atom.family(({ app, ...target }: CallKey) =>
  DashboardClient.runtime.fn((input: Json) =>
    Effect.flatMap(DashboardClient, (client) =>
      client.dashboard.runTool({
        params: { app },
        payload: { ...target, input },
      }),
    ),
  ),
);
export const callToolAtom = (key: ConstructorParameters<typeof CallKey>[0]) =>
  calls(new CallKey(key));
const toolRunApprovals = Atom.family((endpoint: string) => toolRunApproval(BrowserAtoms, endpoint));
export const toolRunApprovalAtoms = (key: {
  readonly app: AppId;
  readonly requestId: ApprovalRequestId;
}) =>
  toolRunApprovals(
    `/dashboard/api/apps/${encodeURIComponent(key.app)}/tools/approvals/${encodeURIComponent(key.requestId)}`,
  );
