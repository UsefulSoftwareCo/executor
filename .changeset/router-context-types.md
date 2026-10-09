---
"apps": patch
---

`accountRouter` and `dynamicRouter` keep the handler contexts of the operations they hold, so
`defineApp` checks them like any router's and app code needs no casts. `accountRouter` accepts a
callback that returns the router or a Promise of it, such as a synchronous `liveOpenapiRouter`, or a
router of hand-written queries and mutations. `dynamicRouter`'s `resolve` accepts any `query()` or
`mutation()` result. `OperationDeclaration` and `OperationChild` are exported. Existing calls keep
their types.
