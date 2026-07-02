For SQLite, we use unique index instead of constraint because:

1. They behave the same for foreign keys.
2. Only unique index can be added and dropped after table creation.

For MSSQL, we use unique index instead of constraint because:

1. Unique constraints include NULL values by default, to disable, we need a filtered unique index.

Also, MSSQL has many limitations on foreign key:

1. Cannot use filtered unique index (which is necessary for us).
2. Cannot define foreign key actions on self-referencing keys (which other databases support).

Hence, MSSQL will use our own virtual foreign key system instead.

Otherwise, we need unique constraint because most SQL databases require unique constraint for foreign keys to work.
