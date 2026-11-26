import type { HostedDocument } from "@executor-js/hosted-web/document";
import type { CloudEntryPage } from "../../../src/contracts/entry.ts";

export interface CloudDocumentContext extends HostedDocument {
  readonly entry: CloudEntryPage | null;
  readonly formerPasskeyHost: string | null;
  readonly documentation: string;
}
