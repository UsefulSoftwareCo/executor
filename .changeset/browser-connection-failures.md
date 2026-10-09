---
"apps": patch
"@executor-js/telemetry": patch
"@executor-js/utils": patch
"@executor-js/ui": patch
"@executor-js/dashboard-start": patch
"@executor-js/hosted-web": patch
"@executor-js/hosted-cloud-web": patch
---

A dashboard request that gets no response now shows "Can’t reach Executor" with Try again instead
of an unexpected-error notice. Browser spans record it as `BrowserConnectionFailed` with the
device's online state, the page's visibility and whether it was leaving. It is expected, and not
reported, only when the device is offline or the page is hidden or leaving; otherwise the error
reporter still receives it. Sentry groups browser failures by kind.
