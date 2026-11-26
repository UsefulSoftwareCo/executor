import type { HostedDocument } from "@executor-js/hosted-web/document";
import { Schema } from "effect";

export const SignInSettings = Schema.Struct({ setup: Schema.Boolean, sso: Schema.Boolean });
export type SignInSettings = typeof SignInSettings.Type;

export interface SelfHostDocumentContext extends HostedDocument {
  readonly signIn: SignInSettings | null;
}
