---
"@executor-js/hosted-self-host": patch
"@executor-js/sdk": patch
"@executor-js/app-templates": patch
---

Self-host operators can let app code reach named private services without opening the whole private network. `EXECUTOR_APPS_ALLOW_PRIVATE_ORIGINS` takes a JSON array of exact HTTP(S) origins, such as `["https://my-mac.example-tailnet.ts.net"]`. Requests to a listed origin go out through a network that can reach private addresses, and each redirect hop is checked again. A private address, or a listed hostname under another scheme or port, is still refused with `NetworkRefused` (`private_address`); a name that only resolves to a private address still fails as a network error.
