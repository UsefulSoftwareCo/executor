---
"@executor-js/dashboard-start": patch
---

A self-hosted dashboard served through a proxy that ends TLS, such as Caddy, Cloudflare Tunnel or
Railway, loads its reads again instead of showing "Could not reach the server". A batch of reads is
accepted when the browser marks it `Sec-Fetch-Site: same-origin` and refused for any other value. A
request without that header must still name the URL the server sees as its `Origin`, so a browser
that sends no `Sec-Fetch-Site` is still refused behind such a proxy.
