import { documentValues } from "@executor-js/dashboard-start/api";
import type { DocumentApi } from "@executor-js/dashboard-start/document-api";
import type { HostedDocumentContext } from "@executor-js/hosted-server/browser/contracts";
import { redirect } from "@tanstack/react-router";
import { lastOrganizationAtom, sessionInitialValues } from "../contracts/auth.ts";
import { Atom } from "effect/reactivity";
import { Option, Schema } from "effect";
import { OrganizationSummary } from "../contracts/organization.ts";
import { resourceOriginsAtom } from "../contracts/mcp.ts";
import { productBrandAtom } from "@executor-js/ui/contracts/product-brand";

export type HostedDocument = HostedDocumentContext & DocumentApi;

export const hostedServerValues = (document: HostedDocument) => [
  ...documentValues(document),
  ...sessionInitialValues(document.session),
  Atom.initialValue(lastOrganizationAtom, document.lastOrganization),
  Atom.initialValue(resourceOriginsAtom, document.resourceOrigins),
  Atom.initialValue(productBrandAtom, document.brand),
];

export const requireSession = (
  document: HostedDocument,
  pathname: string,
  publicPaths: ReadonlyArray<string>,
) => {
  if (document.session !== null || publicPaths.includes(pathname.replace(/(.)\/$/, "$1"))) return;
  throw redirect({ href: `/login?redirect=${encodeURIComponent(document.path)}` });
};

export const restoreLastOrganization = async (document: HostedDocument, pathname: string) => {
  const saved = document.lastOrganization;
  if (pathname !== "/" || document.session === null || saved === null) return;
  const response = await document.apiFetch("/api/auth/organization/list");
  if (!response.ok) return;
  const memberships = Schema.decodeUnknownOption(Schema.Array(OrganizationSummary))(
    await response.json(),
  );
  const organization = Option.flatMap(memberships, (list) =>
    Option.fromNullishOr(list.find((item) => item.id === saved.organization)),
  );
  if (Option.isSome(organization))
    throw redirect({ href: `/org/${encodeURIComponent(organization.value.slug)}/apps` });
};
