# Private invocation v1 prototype

This local companion is an unreleased proposal over JustYannicc's caller/cache
isolation contribution, PR2346 at `6e6c79b50bdca8416a1521ba1c0d3b5e12eadf45`,
whose public v2 base is `9edd4a510301f1bb061a0328c482e1b60e0cb937`.
It does not establish maintainer acceptance, a supported release or production
compatibility. Public contributions target v2 and are ported by maintainers.
Protocol15 and `apps@0.0.1-beta.116-private-invocation.1` distinguish this candidate
from the already occupied beta116. No frozen protocol record is edited.

## Host path

A product explicitly supplies a `PrivateInvocationVerifier` to `makeHostedMcp`.
The hosted implementation takes the principal from authenticated `CurrentUserId`
(the SDK's `CurrentActor`), never a configurable caller name. There is no trust
registration tool, new environment switch, default issuer or enabled product
configuration. Other hosts remain unsupported unless they implement this boundary.

Initialize must offer and receive
`capabilities.experimental.privateInvocation = {version:1,header:"Private-Invocation",directCallOnly:true}`.
A negotiated stateful session is partitioned by the authenticated product session
identity. A restart loses this support cache and requires initialization again;
it never restores authority from that cache. Ordinary sessions are unchanged.

Only a single `tools/call` request naming MCP `call`, with arguments
`{calls:{path,input}}`, can attach the opaque ASCII header (1–512 bytes). Arrays,
execute, resume, notifications and malformed attachments refuse before dispatch.
Requiring apps declare `defineApp({privateInvocation:true}, ...)`. Missing
attachments refuse at the SDK before app calls, including execute/batch/resume
attempts. Ordinary apps cannot receive an attached grant. Their unprotected calls
use their existing path. App-owned upstream MCP headers cannot set the reserved
header; this extension is not a static account credential.

The attachment is captured in the HTTP request, passed only to the request driver's
real backend, and provided around its authorized `callTool`. The detached program
broker deliberately drops authority; it is not used to retain this attachment.
Discovery, factories, model globals, app caches and public Request JSON receive no
reference. Factories get an unavailable `invocation` facade. Private calls disable
elicitation/approval continuation, nested workflow controls and credential-driven automatic redispatch.

The hosted product's `checkedToolCall` resolves the active version and real linked
app/user accounts. The SDK snapshots that selection, resolves current credentials
and verifies the actual caller before redemption. It hashes the copied final wire
input and scoped account IDs with `rfc8785-sha256-v1`: UTF-8 SHA256 of RFC8785
canonical JSON. The implementation uses UTF-16 key order and ECMAScript primitive
serialization as specified by RFC8785, restricts numbers to safe integers exactly like
the paired issuer, refuses floats/unsafe integers/lone surrogates,
nonplain objects/accessors/cycles, and limits depth64/encoded input256KiB. There is
no default JSON serialization fallback. Native input decoding still runs; a
transform that changes the forwarded input fails its final digest comparison.

## Issuer wire refinement requiring paired agreement

The issuer namespace, authenticated HTTPS redeem/forward URLs and one binding ID
are host configuration. Both URLs must share an HTTPS origin, have no embedded
credentials/query/fragment, use native TLS validation and refuse redirects. Transport authentication is supplied as `Redacted`; it never enters app code.
The paired issuer derives its namespace internally, so it is not an extra
receiver-binding field.

POST the configured redeem URL:

```ts
{version:1,reference,binding:{
  digestVersion:"rfc8785-sha256-v1",recipientPrincipal,
  appId,buildId,toolPath,accountsDigest,action:"call",inputDigest
}}
```

For the paired issuer, use `nodePrivateInvocationIssuer` from `@executor-js/sdk/node`,
with operator-provided `Redacted` client certificate/private key/trust CA. Its returned
`verifier` goes into `makeHostedMcp`; close its HTTPS agent at the owned server lifetime.
The Node adapter verifies server TLS, supplies actual client-certificate authentication,
limits its socket count and response size, and never follows redirects. It does not
create certificates, accounts or grants. The shared bearer-auth HTTPS client is also
available for separately configured issuers; it is not a substitute for the paired
issuer's required mTLS.

The actual issuer must compare its independently persisted recipient, native
admitted origin, current policy and immutable operation binding, atomically reserve
redemption and return:

```ts
{
  version: (1, invocationId, operationId, expiresAt, lease);
}
```

`expiresAt` is epoch milliseconds, at most60seconds ahead. IDs and expiry come from
the issuer's saved reference; public arguments cannot select them. They are not
claims minted by Executor. A duplicate redemption must deny or return an existing
authoritative receipt; this client currently accepts only a fresh dispatch lease.
It never retries either POST. Failed/ambiguous redemption is not proof of absence.

The app calls `await ctx.invocation.require(operationId)`, then
`await permit.forward(bindingId,input)`. The generated workerd bridge uses the
existing invocation-owned `control` RPC as a private-command multiplexer; no bearer
is serialized on that RPC or stored in a build. Protocol15 is required before a
private context can reach a retained build. An app's facade has no token getter,
JSON export or usable string coercion. A stopped invocation invalidates it.

Before require/forward, the original request backend reauthenticates its token,
grant and membership, and rechecks the pinned active version, exact current linked
accounts and tool policy. The forward client compares the final input digest and
one configured binding ID, reserves locally before any await, and POSTs:

```ts
{
  version: (1, lease, binding, bindingId, input);
}
```

The issuer must recheck current revocation, expiry, original scope and exact input,
then atomically reserve dispatch to its fixed private destination. The response is
`{version:1,result:JSON}`. Only ordinary results return on the originating call;
known private reference/lease/authentication strings are rejected from results.
An untrusted issuer cannot be made trustworthy by this filtering. Retained origin,
policy/revocation/replay and continuation persistence are owned by the genuine
issuer, not invented by Executor. These endpoint schemas are a concrete refinement
for paired review, not an assertion that another product already implements them.

## Durable effect journal and actual conformance

`e2e/fixtures/private-invocation/index.ts` is a real authored app, not an issuer or
fake service. Deploy it through actual product authorization with the migration
file at `migrations/0001_operations.sql` and the candidate exact apps dependency.
It reserves `(operationId,principal,inputDigest)` in SQLite before forwarding,
keeps ambiguous effects `unknown`, refuses redispatch of unknown work and only
returns an observed duplicate to the same authenticated principal/hash. Its
separately authorized `status` query reads the durable journal. A successful
forward response is an observation, not independent business-effect verification.
Cancellation never claims remote undo. Snapshots/restarts belong to the fixture
owner; this driver does not manipulate a product database or process.

The dependency-free external driver runs on the repository's existing Node24:

```sh
node e2e/private-invocation-driver.ts --fixture /protected/fixture.json --evidence /protected/evidence
```

One real external scenario is registered in `e2e/tests/private-invocation.spec.ts`
and `e2e/test-plan.ts`. Its suite adapter owns a separate Node process and retains
its outcome using existing evidence services. Targets are explicitly `not-run`
until genuine fixtures and a product composition are owned and provisioned. The
ordinary CI actor seeding/emulators cannot supply admitted native-human authority.
The exact future suite command, after fixture ownership and target scheduling, is:

```sh
EXECUTOR_PRIVATE_INVOCATION_FIXTURE=/protected/fixture.json bun run e2e:self-host --test-name '^Private invocation external genuine origin direct effect and replay confinement$'
```

The mode0600 manifest has this shape (file paths are private fixture injection,
never credentials or references in source):

```ts
{
  version:1,mcpUrl:"https://owned-development-host/mcp",tokenFile:"/protected/product-token",
  direct:{path:"tools[\"app_slug\"].dispatch",input:{operationId:"issued-operation",value:"owned-effect"},referenceFile:"/protected/direct-reference"},
  journal:{path:"tools[\"app_slug\"].status",input:{operationId:"issued-operation"},referenceFile:"/protected/journal-reference"},
  effect:{path:"tools[\"readback_slug\"].read",input:{operationId:"issued-operation"},referenceFile:"/protected/readback-reference"},
  expectedResult:{/* independently expected ordinary result */},expectedEffect:{/* exact effect/count */},
  provenance:{executorHead:"<40hex>",issuerHead:"<40hex>",nativeAdmissionReceiptFile:"/protected/native-admission",authenticatedAccountReceiptFile:"/protected/real-auth-account",ownedProcessesReceiptFile:"/protected/process-storage-ownership"}
}
```

The fixture owner must provide actual modified product/issuer processes, TLS trust,
real signup/login/consent and selected accounts, an admitted native human event and
three fresh scoped operation references (direct, journal read, independent actual
effect readback). Receipt files are evidence prerequisites, never authority accepted
by either product. No fake issuer, SQL-seeded authentication, signed source JSON or
production auth copy is valid. The independent readback must show the expected
single effect after replay; it cannot be the forward response echoed back.

Missing fixtures exit2 before network. Failed assertions exit1. Successful execution
records one scenario/four calls, without confidential traffic bodies. No zero-case
PASS exists. This scenario does not yet prove overlapping principals/origins,
all expiry/tamper/mismatch denials, restart/rebind/revocation, induced response loss,
model/trace privacy or old-host compatibility. Those remain explicit acceptance
gaps. No genuine scenario, model call or release acceptance is claimed here.
