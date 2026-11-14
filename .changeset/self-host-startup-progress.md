---
"@executor-js/hosted-self-host": patch
---

Open the self-host database as soon as the container starts instead of on the first request, answer requests with an immediate 503 and log progress until the server is ready, and allow two minutes before the image's health check counts failures.
