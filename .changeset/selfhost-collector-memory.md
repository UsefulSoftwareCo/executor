---
"@executor-js/hosted-self-host": patch
---

On self-host, the telemetry collector's process now collects its isolate's
garbage after 2 seconds idle and returns the freed memory. With 30 apps on
per-minute schedules it stayed between 76 and 96 MB over three hours, where it
had risen to about 430 MB.
