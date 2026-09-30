---
"@executor-js/sdk": patch
---

fix: make pending-approval consumption atomic

`PendingApprovalStore.consume` previously read the record and deleted it as
two separate operations. Two concurrent resumes (a double-click, a client
retry, or two hosts racing the same approval) could both read the record
before either deleted it, and both would execute the approved tool call —
duplicated side effects from a single approval.

Consumption now goes through a new `BlobStore.compareAndDelete` primitive
with a single-winner guarantee: exactly one concurrent consumer observes the
record as present-and-removed; everyone else observes it as absent. The
in-memory store implements it as a synchronous Map operation (atomic in JS's
single-threaded model); the FumaDB-backed store implements it as
get+delete inside the serializing transaction the driver already provides
(libSQL/Postgres BEGIN/COMMIT). The approval's expiry and corrupt-record
semantics are unchanged.
