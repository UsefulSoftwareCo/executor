import { useAtomValue } from "@effect/atom-react";
import { documentationBaseAtom, documentationPage } from "../contracts/documentation.ts";

export const useDocumentationUrl = (path = ""): string =>
  documentationPage(useAtomValue(documentationBaseAtom), path);
