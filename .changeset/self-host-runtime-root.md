---
"@executor-js/hosted-self-host": patch
---

The self-host image's runtime under `/app`, such as `product.mjs`,
`workerd.capnp` and the workerd binary, now belongs to root and is read-only to
the user the server runs as. Only the data directories are that user's.
