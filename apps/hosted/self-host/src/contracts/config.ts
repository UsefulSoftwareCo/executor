/** Self-host storage configuration shared by the database, retained builds and diagnostics. */
import { AppUiBaseUrl } from "@executor-js/hosted-server/app-ui/contracts";
import { isPrivateHostname } from "@executor-js/utils/url-policy";
import { Config, Effect, Option, Schema } from "effect";

/** One persistent root; Docker supplies /app/data and source development uses .local/hosted. */
export const dataDirectory = Config.NonEmptyString("EXECUTOR_DATA_DIR").pipe(
  Config.withDefault(".local/hosted"),
);

/** Localhost works without DNS setup; production operators explicitly supply their app DNS base. */
export const appUiBaseUrl = (dashboardOrigin: string) =>
  Effect.gen(function* () {
    const configured = yield* Config.String("EXECUTOR_APP_UI_BASE_URL").pipe(Config.option);
    if (Option.isSome(configured))
      return yield* Schema.decodeUnknownEffect(AppUiBaseUrl)(configured.value);
    const dashboard = new URL(dashboardOrigin);
    if (dashboard.hostname !== "localhost" && dashboard.hostname !== "127.0.0.1") return undefined;
    dashboard.hostname = "localhost";
    return yield* Schema.decodeUnknownEffect(AppUiBaseUrl)(dashboard.origin);
  });

/**
 * App isolates reach only public addresses, the same as Executor Cloud. The bundled Executor
 * app calls the dashboard origin from inside an isolate, so an instance served on loopback, a
 * private address or a single-label name cannot use its own tools under that rule. Derive the
 * default from the same destination rule `parseDestination` applies. An explicit setting wins.
 */
export const allowPrivateAppFetch = (dashboardOrigin: string) =>
  Effect.gen(function* () {
    const configured = yield* Config.Boolean("EXECUTOR_APPS_ALLOW_PRIVATE_FETCH").pipe(
      Config.option,
    );
    if (Option.isSome(configured)) return configured.value;
    const dashboard = URL.parse(dashboardOrigin);
    // A malformed origin already fails startup elsewhere. Never widen the network because of it.
    if (dashboard === null || !isPrivateHostname(dashboard.hostname)) return false;
    yield* Effect.logInfo(
      `Private app fetch is enabled because the dashboard origin ${dashboardOrigin} is not public.` +
        " App code can reach this network. Set EXECUTOR_APPS_ALLOW_PRIVATE_FETCH=false to refuse it.",
    );
    return true;
  });
