import { Schema } from "effect";

/** `EXECUTOR_CREDENTIAL_ADAPTER_URL` is not an adapter origin the host's egress policy allows. */
export class CredentialAdapterUrlInvalid extends Schema.TaggedError<CredentialAdapterUrlInvalid>()(
  "CredentialAdapterUrlInvalid",
  { message: Schema.String },
) {}
