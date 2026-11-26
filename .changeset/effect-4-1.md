---
"@executor-js/sdk": minor
"apps": patch
---

Executor runs on Effect 4.1. Effect removed its `Crypto` service, so
`createExecutor` from `@executor-js/sdk/core` now requires `SecureRandom` and
`Digest` from `effect/crypto` instead. Provide them from your platform, for example
`NodeCrypto.layerSecureRandom` and `NodeCrypto.layerDigest` from
`@effect/platform-node`, or `SecureRandom.layerWebCrypto` and
`Digest.layerWebCrypto`. The Promise `createExecutor` from `@executor-js/sdk` is
unchanged.
