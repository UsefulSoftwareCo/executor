# Credential access and review

This runbook defines the review process for the hosted application. A policy
is not evidence that a review took place. Keep dated review records outside
the public repository, with the scope, findings, owner, and follow-up actions.

## Access

- Store connected-service credentials in WorkOS Vault. Resolve credentials
  only after tenant and subject authorization. Bind vault objects to their
  owner and key context. Do not expose plaintext credentials in list or
  metadata responses.
- Store deployment credentials in managed secret bindings. Give a service
  only the credentials it needs. Separate production and development keys.
- Require MFA for human access to production infrastructure. Application
  administration requires a fresh, session-bound second-factor verification.
- Use personal identities for human administration. Review provider team
  membership and service credentials when access changes. Revoke access when
  a person or service no longer needs it.
- Do not log passwords, tokens, cookies, request bodies, payment details, or
  raw provider errors. Keep operation names, status codes, safe error classes,
  source positions, and trace identifiers for diagnosis.

## Machine keys

Machine API keys support unattended integrations. They are distinct from
interactive sessions. A personal key acts as its owning member and cannot
satisfy an administrator verification. Organization keys cannot satisfy the
interactive administrator gate. Evaluate tenant and subject authorization on
requests; validate key validity with WorkOS.

For rotation, create a replacement key, update the authorized workload, verify
its requests, then revoke the old key. Revoke immediately after suspected
exposure. Do not revoke active customer keys merely to demonstrate this
procedure. Use an isolated test identity for revocation tests.

## Review procedure

The service owner performs the following review weekly and after an access or
credential incident:

1. Review WorkOS Vault access events for unexpected actors, unusual volumes,
   or access outside the affected workload. Inspect metadata, not secret values.
2. Compare provider team access and service credentials with current needs.
3. Review authentication and billing failures in Cloudflare and Sentry. Use
   safe trace identifiers to investigate. Check that diagnostics omit secrets.
4. Verify query-string redaction after deployments and changes to telemetry.
5. Record the date, evidence range, sample size, findings, and actions in the
   private security evidence folder. Distinguish a sample from a full review.

If access is unexplained, preserve safe evidence, determine the affected
scope, revoke or rotate the affected credential, and verify that the old
credential no longer works. Follow the incident process for any customer
notification; do not publish customer or secret data in issues.

## Evidence limits

A visible event sample establishes that those events were recorded. It does
not establish complete coverage, a retention period, or automated alerting.
Record configured retention and alert destinations only when verified in the
provider. This runbook does not claim that automated Vault alerts exist.

External identity providers control their own passwords. Do not claim that
changing a federated password invalidates application sessions without an
observed or documented signaling and revocation path. WorkOS documents that
its own password reset revokes active WorkOS sessions; locally verified access
tokens remain usable until their acceptance window ends.
