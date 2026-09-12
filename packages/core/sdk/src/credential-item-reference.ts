import { Option, Schema } from "effect";

const CredentialWriteAttempt = Schema.Struct({
  runtimeId: Schema.String,
  attemptId: Schema.String,
});

/** Persisted executor ownership metadata for one credential write attempt. */
export type CredentialWriteAttempt = typeof CredentialWriteAttempt.Type;

const decodeCredentialWriteAttempt = Schema.decodeUnknownOption(CredentialWriteAttempt);
const decodeCredentialWriteAttemptJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(CredentialWriteAttempt),
);

/** Build the structured metadata stored alongside opaque provider item ids. */
export const makeCredentialWriteAttempt = (
  runtimeId: string,
  attemptId: string,
): CredentialWriteAttempt => ({ runtimeId, attemptId });

/** Parse persisted write-attempt metadata without inspecting a provider item id. */
export const parseCredentialWriteAttempt = (value: unknown): CredentialWriteAttempt | null =>
  Option.getOrNull(
    typeof value === "string"
      ? decodeCredentialWriteAttemptJson(value)
      : decodeCredentialWriteAttempt(value),
  );

/**
 * Give one logical credential slot a provider item id unique to one write
 * attempt. This format is generation-only: provider ids remain opaque after
 * creation and ownership is determined exclusively from persisted metadata.
 */
export const credentialAttemptItemId = (baseItemId: string, attemptId: string): string => {
  const terminalSeparator = baseItemId.lastIndexOf(":");
  if (terminalSeparator < 0) return `${baseItemId}:${attemptId}`;
  return `${baseItemId.slice(0, terminalSeparator)}:${attemptId}${baseItemId.slice(terminalSeparator)}`;
};
