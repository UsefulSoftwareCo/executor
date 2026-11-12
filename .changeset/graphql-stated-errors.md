---
"apps": patch
---

A `graphqlRouter` failure now quotes the errors the GraphQL server stated in its response's
`errors` list: each message, its response path and the scalar `extensions` entries, such as
`code`, bounded and with account secrets replaced. A client error status, such as HTTP 400 for a
request that fails validation, reads its GraphQL errors too, from a JSON body of at most 64 KiB
that arrives within 2 seconds; past either, the failure keeps the status and says the body was not
read. Before, every such failure reached the caller as "GraphqlError was thrown without a
message" with only its phase, reason and status.
