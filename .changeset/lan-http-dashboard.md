---
"@executor-js/hosted-self-host": patch
"@executor-js/hosted-web": patch
"@executor-js/ui": patch
"@executor-js/utils": patch
"@executor-js/telemetry": patch
---

The self-host dashboard works when served over plain HTTP at a LAN address. Browsers give such a page no secure context, so `crypto.randomUUID` and `navigator.clipboard` are missing there; every dashboard request failed with "Unable to complete this request", and copy buttons failed. Dashboard IDs now come from `crypto.getRandomValues`, and copy buttons fall back to the document's copy command.
