/** Same-origin browser telemetry includes failures before pairing. Destinations remain server-owned. */
import { receiveBrowserTelemetry } from "@executor-js/telemetry/http";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import type { ServerConfig } from "../contracts/config.ts";
import { localRequest } from "./auth.ts";

/** Origin/Host checks protect write-only ingestion; the composition root chooses the signal route. */
export const browserTelemetry = (config: ServerConfig, signal: "traces" | "logs") =>
  localRequest(config.port, config.browserOrigin).pipe(
    Effect.andThen(receiveBrowserTelemetry(signal)),
    Effect.catchTag("AuthForbidden", () =>
      Effect.succeed(HttpServerResponse.empty({ status: 403 })),
    ),
  );
