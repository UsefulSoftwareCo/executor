import { BootstrapToken } from "@executor-js/local-server/auth";
import { useAtomSet } from "@effect/atom-react";
import { Effect, Option, Schema } from "effect";
import { useEffect } from "react";
import { pairingTokenAtom } from "../contracts/connection.ts";

export const readPairingToken = Effect.gen(function* () {
  const input = new URLSearchParams(window.location.hash.slice(1)).get("pair");
  if (input !== null)
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
  yield* Effect.try(() => sessionStorage.removeItem("executor.local.api-key")).pipe(Effect.ignore);
  if (input === null) return undefined;
  return Option.getOrUndefined(Schema.decodeUnknownOption(BootstrapToken)(input));
});

export function usePairingLinks() {
  const setToken = useAtomSet(pairingTokenAtom);
  useEffect(() => {
    const receive = () => {
      const token = Effect.runSync(readPairingToken);
      if (token !== undefined) setToken(token);
    };
    window.addEventListener("hashchange", receive);
    receive();
    return () => window.removeEventListener("hashchange", receive);
  }, [setToken]);
}
