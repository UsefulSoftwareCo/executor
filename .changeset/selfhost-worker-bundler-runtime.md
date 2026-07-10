---
"executor": patch
---

Ship @cloudflare/worker-bundler in the self-host Docker runtime so the server starts; it was resolved at runtime since the dynamic Worker bundler change but never copied into the image.
