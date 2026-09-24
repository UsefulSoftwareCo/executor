import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { WorkOSError } from "../auth/errors";

// ---------------------------------------------------------------------------
// Cloud-local org API — the WorkOS domain-verification surface only. Members /
// roles / invite / org-name moved to the shared provider-neutral `/account/*`
// surface (served by the WorkOS AccountProvider). Domains stay here because they
// have no provider-neutral equivalent and are cloud-only.
// ---------------------------------------------------------------------------

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()(
  "Forbidden",
  {},
  { httpApiStatus: 403 },
) {}

const RemoveResponse = Schema.Struct({
  success: Schema.Boolean,
});

const DomainItem = Schema.Struct({
  id: Schema.String,
  domain: Schema.String,
  state: Schema.String,
  verificationToken: Schema.optional(Schema.String),
  verificationPrefix: Schema.optional(Schema.String),
});

const DomainsResponse = Schema.Struct({
  domains: Schema.Array(DomainItem),
});

const DomainVerificationLinkResponse = Schema.Struct({
  link: Schema.String,
});

const DomainParams = { domainId: Schema.String };

export class OrgApi extends HttpApiGroup.make("org")
  .add(
    HttpApiEndpoint.get("listDomains", "/org/domains", {
      success: DomainsResponse,
      error: WorkOSError,
    }),
  )
  .add(
    HttpApiEndpoint.post("getDomainVerificationLink", "/org/domains/verify-link", {
      success: DomainVerificationLinkResponse,
      error: [WorkOSError, Forbidden],
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteDomain", "/org/domains/:domainId", {
      params: DomainParams,
      success: RemoveResponse,
      error: [WorkOSError, Forbidden],
    }),
  ) {}

/** Org API with org-level auth supplied by the router middleware in auth-middleware.ts. */
export const OrgHttpApi = HttpApi.make("org").add(OrgApi);
