import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { allSecretsAtom } from "../api/atoms";
import { useScope } from "../api/scope-context";
import type { SecretPickerSecret } from "./secret-picker";

export function useSecretPickerSecrets(): readonly SecretPickerSecret[] {
  const scopeId = useScope();
  const secrets = useAtomValue(allSecretsAtom(scopeId));

  return AsyncResult.match(secrets, {
    onInitial: () => [] as SecretPickerSecret[],
    onFailure: () => [] as SecretPickerSecret[],
    onSuccess: ({ value }) =>
      value.map(
        (secret: {
          readonly id: string;
          readonly scopeId: string;
          readonly name: string;
          readonly provider?: string;
        }) => ({
          id: secret.id,
          scopeId: String(secret.scopeId),
          name: secret.name,
          provider: secret.provider ? String(secret.provider) : undefined,
        }),
      ),
  });
}
