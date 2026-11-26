import { receiveBrowserTelemetry } from "@executor-js/telemetry/http";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import type { ServerConfig } from "../contracts/config.ts";
import { localRequest } from "./auth.ts";

export const browserTelemetry = (config: ServerConfig, signal: "traces" | "logs") =>
  localRequest(config.port, config.browserOrigin).pipe(
    Effect.andThen(receiveBrowserTelemetry(signal)),
    Effect.catchTag("AuthForbidden", () =>
      Effect.succeed(HttpServerResponse.empty({ status: 403 })),
    ),
  );
