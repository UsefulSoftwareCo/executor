---
"@executor-js/plugin-openapi": patch
---

Correct the Microsoft Graph OneNote page write contracts. Page create (`POST .../onenote/.../pages`) now sends raw `text/html` by default, or `multipart/form-data` with a required `Presentation` part, instead of the JSON body that Graph rejects with HTTP 415. Page update adds the documented `PATCH .../pages/{id}/content` operation, which takes a JSON array of patch commands and returns `204`. The generated octet-stream `PUT` on that path stays available but is marked deprecated. The correction applies to every OneNote root (`/me`, `/users`, `/groups`, `/sites`) and nested section form, when slices are generated and when a Graph spec is compiled. Existing integrations pick up the corrected tools when they refresh their spec.
