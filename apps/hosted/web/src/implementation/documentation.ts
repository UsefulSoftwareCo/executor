/** Documentation links resolved against the documentation base the server sent with this page. */
import { useAtomValue } from "@effect/atom-react";
import { documentationBaseAtom, documentationPage } from "../contracts/documentation.ts";

/** The absolute URL of a documentation page; the empty path is the documentation index. */
export const useDocumentationUrl = (path = ""): string =>
  documentationPage(useAtomValue(documentationBaseAtom), path);
