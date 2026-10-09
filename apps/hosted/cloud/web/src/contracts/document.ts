/** Request data the Worker hands to the document renderer. */
import type { HostedDocument } from "@executor-js/hosted-web/document";
import type { CloudEntryPage } from "../../../src/contracts/entry.ts";

export interface CloudDocumentContext extends HostedDocument {
  /** Sign-in or team setup data the Worker resolved for this page, if it is an entry page. */
  readonly entry: CloudEntryPage | null;
  /**
   * The host whose passkeys no longer sign in here, once the dashboard has moved off it
   * (`v2.executor.sh`); null while the dashboard still serves its own host.
   */
  readonly formerPasskeyHost: string | null;
  /** Where the deployment serves its documentation, as an absolute URL ending in `/`. */
  readonly documentation: string;
}
