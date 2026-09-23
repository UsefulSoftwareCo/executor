# Scheduled notes

Deploy `index.ts` as an app, open its Schedules tab, and enable a schedule.
Use Run now to try it without waiting. Call `queries.list` to read recorded notes.

The mutation requests approval. The default Skip approvals setting accepts it.
Switch to Browser approvals, then use Run now and review it on the Approvals page.
Declining or allowing the request to expire does not write a note. Pause the
schedule when finished. Notes use the app's persistent database.
