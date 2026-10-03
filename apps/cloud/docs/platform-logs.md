# Platform logs

Apply `apps/cloud/logpush.json` to the account's `workers_trace_events` Logpush
job as the JSON body of `PUT /accounts/{account_id}/logpush/jobs/{job_id}`.
This updates output fields without changing the destination or event selection.
Wrangler's `logpush: true` enables export for the Worker; it does not manage
the account-level job configuration.

The field list retains outcomes, logs, exceptions, timings and script metadata.
It excludes `Event`, which contains request URLs and other source-event data.
Worker observability query redaction is separate from Logpush output selection.
Redacted request paths and HTTP statuses remain available in application traces.

After applying, read back the job's output options and check newly delivered
records at the destination. Allow for configuration propagation and in-flight
batches. Verify that `Event` is absent and retained diagnostic fields still arrive.
This does not remove historical records or sanitize arbitrary console messages.
