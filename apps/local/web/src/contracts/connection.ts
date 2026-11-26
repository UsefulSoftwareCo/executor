import { dashboardHttpClient, hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { DashboardRuntime } from "./telemetry.ts";
import { LocalAuthApi, type BootstrapToken } from "@executor-js/local-server/auth";
import { Effect } from "effect";
import { HttpClient } from "effect/http";
import { Atom, AtomHttpApi } from "effect/reactivity";

export class AuthClient extends AtomHttpApi.Service<AuthClient>()("AuthClient", {
  api: LocalAuthApi,
  runtime: DashboardRuntime,
  transformClient: (client) =>
    client.pipe(HttpClient.transformResponse(Effect.withSpan("ui.auth"))),
  httpClient: dashboardHttpClient,
}) {}

export const pairingTokenAtom = Atom.make<typeof BootstrapToken.Type | undefined>(undefined).pipe(
  Atom.keepAlive,
);
export const sessionAtom = AuthClient.query("auth", "session", hydrated({})).pipe(revalidated);
export const bootstrapAtom = AuthClient.runtime
  .atom((get) =>
    Effect.gen(function* () {
      const token = get(pairingTokenAtom);
      if (token !== undefined) {
        const client = yield* AuthClient;
        yield* client.auth.exchange({ payload: { token } });
        get.refresh(sessionAtom);
      }
    }),
  )
  .pipe(Atom.keepAlive);
