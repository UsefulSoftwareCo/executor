---
"@executor-js/execution": patch
---

**Large execute results are measured once, not once per span**

The result-size telemetry probe serializes the whole returned value to count its characters, and that cost grows with the payload. The same result object was walked again every time it was stamped onto another span: an operator-approved run measured it twice (inner and outer span), and every retried `resume` that replayed a settled outcome measured it again. The measurement is now computed once per result object and reused, so a large result pays one size walk no matter how many spans report it. Response text, structured content, and span attribute values are unchanged.
