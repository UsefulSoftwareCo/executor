import { getGlobalStartContext } from "@tanstack/react-start";
import type { SelfHostDocumentContext } from "../contracts/document.ts";

/** Server only: the context the product server passed with this document request. */
export const serverDocument = (): SelfHostDocumentContext => {
  const document = getGlobalStartContext();
  if (document === undefined)
    throw new Error("The document context is only available on the server");
  return document;
};

declare module "@tanstack/react-start" {
  interface Register {
    server: { requestContext: SelfHostDocumentContext };
  }
}
