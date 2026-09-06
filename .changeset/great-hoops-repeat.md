---
"@executor-js/plugin-openapi": patch
---

Fetch Google Analytics Data (`analyticsdata`) Discovery from the service's own
host. The central directory does not list the GA4 Data API, so the canonical
`https://www.googleapis.com/discovery/v1/apis/analyticsdata/v1beta/rest` answers
404 and the source fails to import. Same treatment `forms`, `keep` and
`photospicker` already get.
