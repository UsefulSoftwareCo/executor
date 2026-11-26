# Distilled AWS patch

`@distilled.cloud%2Faws@1.0.0-rc.13.patch` changes one schema in `services/s3`, in the
published JavaScript (`lib/`) and the TypeScript source (`src/`).

S3's `Metadata` was `Record(String, optional(String))`. Effect 4.1 refuses an optional
value in a record when the schema is built, so the module failed to load:
`Cannot use Schema.optionalKey or Schema.optional with index signatures`. Alchemy's
Neon provider imports the S3 client, and Cloud's stack imports that provider, so
`alchemy dev` and every deploy stopped while importing the stack. The value is now
`UndefinedOr(String)`, which is the declared type, `string | undefined`.

rc.13 has the same shape in other AWS services, none of which Executor loads. rc.18,
which alchemy beta.85 uses, builds its schemas with the client's own module, where the
check does not apply; alchemy beta.80 pins rc.13. Drop the patch with the move to alchemy beta.85 or later.
