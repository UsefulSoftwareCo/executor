/** Request data the product server hands to the document renderer. */
import type { HostedDocument } from "@executor-js/hosted-web/document";
import { Schema } from "effect";

/** Whether first-run setup is open and whether the operator enabled SSO; no users or secrets. */
export const SignInSettings = Schema.Struct({ setup: Schema.Boolean, sso: Schema.Boolean });
export type SignInSettings = typeof SignInSettings.Type;

export interface SelfHostDocumentContext extends HostedDocument {
  /**
   * The sign-in settings the server read for a sign-in page, so it renders the form the visit
   * needs; `null` on other pages, or when they could not be read and the browser asks again.
   */
  readonly signIn: SignInSettings | null;
}
