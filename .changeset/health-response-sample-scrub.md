---
"executor": patch
---

**Credentials are kept out of the health-check result that gets persisted**

A health check stores a sample of the probed operation's response body, plus the extracted identity, in `connection.last_health` — so whatever those carry is written to the database. The operation is user-chosen from the plugin's catalog, which means it can just as easily be a key-listing endpoint as a `/me`, and those return secrets that no scrub of the connection's own credential value can recognise, because they are different secrets entirely.

Two passes now cover both kinds of secret:

- **By key name.** Leaves whose key names a credential (`token`, `api_key`, `secret`, `authorization`, `session`, …) have their value replaced with `[redacted]`. The row itself is kept, so the live preview still shows the response shape and the identity picker still works. Keys that merely contain a matching substring, such as `author`, are left alone. camelCase spellings are recognised too: `accessToken`, `refreshToken`, `clientSecret`, `privateKey` and `sessionId` have no separator before the credential word, so a matcher that only looks for one reads them as innocent.
- **By value.** The OpenAPI health check removes the connection's own credential value from each sampled value, covering the other direction: a body that echoes back the key it was authenticated with under an innocent-looking name. This runs before the sample's 120-char truncation, not after — truncating first leaves a prefix of a long credential that an exact-value scrub can no longer match, and that prefix is what would be persisted.

The key check reads a dotted path two ways. It uses the nearest NAMED segment, because array elements are named by index: `{"tokens": ["sk-live-…"]}` produces the path `tokens.0`, and testing the literal `"0"` matches nothing. It also uses an enclosing array container, because a key listing returns `{"api_keys": [{"value": "sk-live-…"}]}`, whose path is `api_keys.0.value` — the nearest named segment there is the innocent `value`, and only the array's own key says what the collection holds. A collection whose key names nothing, such as `names.0`, is still shown in full.

The extracted `identity` goes through both passes as well. It is read straight off the raw body, so it previously bypassed them even though it is persisted the same way, and `identityField` is user-chosen from whatever the picker listed.
