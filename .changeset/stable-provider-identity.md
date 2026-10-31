---
"@executor-js/sdk": patch
---

Rewording a provider no longer makes it a new provider. Its ID leaves out
display text: each secrets method's `label` and its fields' `title` and
`description`. Accounts linked through an app keep filling its requirement
after a label change, and apps that word one provider differently share its ID
and accounts, while each connect form shows its own app's wording.

Text in an OAuth method's `response` schema still counts.

Providers stored before keep their IDs. A deploy reuses the ID its app's active
version has for the same provider. Otherwise an app with the exact wording of an
older stored provider keeps that provider's ID, and other wordings use the
least stored ID of the same provider; only a provider with no stored row gets a
new one. Storage version 4.0.17 records each provider's identity, and 4.0.18
indexes it. A deploy records it for stored providers of the names it declares,
and data step `11_provider_identities` for the rest.
