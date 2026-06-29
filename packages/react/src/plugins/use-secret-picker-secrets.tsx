import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import type { Connection } from "@executor-js/sdk/shared";

import { connectionsAllAtom } from "../api/atoms";
import type { SecretPickerSecret } from "./secret-picker";

// ---------------------------------------------------------------------------
// v2: the picker lists connections across BOTH owners (the global owner toggle
// is retired). A connection IS the credential, so each row maps a connection to
// a `SecretPickerSecret` keyed by its name + its own owner + resolving provider.
// ---------------------------------------------------------------------------

export function useSecretPickerSecrets(): readonly SecretPickerSecret[] {
  const connections = useAtomValue(connectionsAllAtom);

  return AsyncResult.match(connections, {
    onInitial: () => [] as SecretPickerSecret[],
    onFailure: () => [] as SecretPickerSecret[],
    onSuccess: ({ value }) =>
      value.map(
        (connection: Connection): SecretPickerSecret => ({
          id: String(connection.name),
          owner: connection.owner,
          name: connection.identityLabel ?? String(connection.name),
          provider: String(connection.provider),
        }),
      ),
  });
}
