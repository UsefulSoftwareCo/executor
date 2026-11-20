---
"apps": patch
---

An OpenAPI operation whose security also allows no credentials (an empty `{}`
alternative) now sends the selected account's credential. Before, an empty
alternative listed before the account's scheme was taken first, so the call went
out anonymous even with an account selected, and the API answered with its
public view or rate limits.
