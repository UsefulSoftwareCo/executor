/** Server-rendered hosted pages: the session and API a document receives from its host. */
import { documentValues } from "@executor-js/dashboard-start/api";
import type { DocumentApi } from "@executor-js/dashboard-start/document-api";
import type { HostedDocumentContext } from "@executor-js/hosted-server/browser/contracts";
import { redirect } from "@tanstack/react-router";
import { lastOrganizationAtom, sessionInitialValues } from "../contracts/auth.ts";
import { Atom } from "effect/reactivity";
import { Option, Schema } from "effect";
import { OrganizationSummary } from "../contracts/organization.ts";
import { resourceOriginsAtom } from "../contracts/mcp.ts";

/** Everything a hosted document receives from its host. */
export type HostedDocument = HostedDocumentContext & DocumentApi;

/** The server registry reads in-process and starts from the verified session. */
export const hostedServerValues = (document: HostedDocument) => [
  ...documentValues(document),
  ...sessionInitialValues(document.session),
  Atom.initialValue(lastOrganizationAtom, document.lastOrganization),
  Atom.initialValue(resourceOriginsAtom, document.resourceOrigins),
];

/**
 * Send a confirmed signed-out visitor to sign-in before any HTML, keeping the requested address
 * exactly, including signed OAuth queries. Only `publicPaths` render without a session.
 */
export const requireSession = (
  document: HostedDocument,
  pathname: string,
  publicPaths: ReadonlyArray<string>,
) => {
  if (document.session !== null || publicPaths.includes(pathname.replace(/(.)\/$/, "$1"))) return;
  throw redirect({ href: `/login?redirect=${encodeURIComponent(document.path)}` });
};

/**
 * Open `/` at the organization this person last used, before any HTML. Membership is checked in
 * the same request, so a removed organization shows the normal entry instead; the saved value
 * is only navigation memory. The address uses the organization's current slug, so the page does
 * not replace its own URL while its data is still streaming.
 */
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
