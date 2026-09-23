-- The `from-database` migration script this package generates for SQLite.
-- Compared against test/snapshots/upstream/migration/kysely.sqlite-from-database.sql
-- (the script upstream fumadb produced through Kysely), it differs in exactly
-- two places, both corrections in src/sql/introspect.ts.
--
-- fumadb-effect deviation: no `drop index if exists "sqlite_autoindex_<table>_1"`.
-- Upstream read the implicit index behind a non-integer PRIMARY KEY as a unique
-- constraint, so its diff dropped it as unused. SQLite refuses that drop even
-- with `if exists` ("index associated with UNIQUE or PRIMARY KEY constraint
-- cannot be dropped"), so upstream's script cannot run. `listUniqueIndexes`
-- skips `origin = 'pk'` instead. Two statements are gone: the autoindex of
-- "prefix_0_accounts" in step 2 and of "prefix_1_accounts" in step 3.
--
-- fumadb-effect deviation: step 3 recreates "prefix_1_accounts" as
-- "prefix_2_accounts" instead of renaming it. 2.0.0 gives accounts.email a
-- `default 'test'` and 3.0.0 has no default, and SQLite can only drop a column
-- default by rebuilding the table. Upstream's SQLite introspection did not
-- recover column defaults, so it emitted a bare rename and left the stale
-- default in the database. The statements below are identical to upstream's own
-- `from-schema` plan for the same step (kysely.sqlite-from-schema.sql), which is
-- the behaviour a from-database migration has to converge on.
--
-- Recovering real foreign key names from `sqlite_master` (PRAGMA
-- foreign_key_list does not report them) is what keeps the rest of the script
-- identical: without it every foreign key would look renamed.
PRAGMA defer_foreign_keys = ON;

create table "prefix_0_users" ("id" text not null primary key, "image" text default 'my-avatar', "data" blob);

create table "prefix_0_accounts" ("secret_id" text not null primary key);

create table "private_test_settings" ("key" text primary key, "value" text not null);

insert into "private_test_settings" ("key", "value") values ('version', '1.0.0');

insert into "private_test_settings" ("key", "value") values ('name-variants', '{"users":{"sql":"prefix_0_users"},"users.id":{"sql":"id"},"users.image":{"sql":"image"},"users.data":{"sql":"data"},"accounts":{"sql":"prefix_0_accounts"},"accounts.id":{"sql":"secret_id"}}');
/* --- */
PRAGMA defer_foreign_keys = ON;

alter table "prefix_0_accounts" rename to "prefix_1_accounts";

alter table "prefix_1_accounts" add column "email" text default 'test' not null;

create unique index "unique_c_accounts_email" on "prefix_1_accounts" ("email");

create table "prefix_1_users" ("id" text not null primary key, "name" text not null, "email" text not null, "image" text default 'another-avatar', "string" text, "bigint" blob, "integer" integer, "decimal" real, "bool" integer, "json" text, "binary" blob, "date" integer, "timestamp" integer, "fatherId" text, constraint "users_accounts_account_fk" foreign key ("email") references "prefix_1_accounts" ("secret_id") on delete cascade on update restrict, constraint "users_users_father_fk" foreign key ("fatherId") references "prefix_1_users" ("id") on delete restrict on update restrict);

create unique index "unique_c_users_email" on "prefix_1_users" ("email");

create unique index "unique_c_users_fatherId" on "prefix_1_users" ("fatherId");

INSERT INTO "prefix_1_users" ("id", "image") SELECT "id" as "id", "image" as "image" FROM "prefix_0_users";

drop table "prefix_0_users";

update "private_test_settings" set "value" = '2.0.0' where "key" = 'version';

update "private_test_settings" set "value" = '{"users":{"sql":"prefix_1_users"},"users.id":{"sql":"id"},"users.name":{"sql":"name"},"users.email":{"sql":"email"},"users.image":{"sql":"image"},"users.stringColumn":{"sql":"string"},"users.bigintColumn":{"sql":"bigint"},"users.integerColumn":{"sql":"integer"},"users.decimalColumn":{"sql":"decimal"},"users.boolColumn":{"sql":"bool"},"users.jsonColumn":{"sql":"json"},"users.binaryColumn":{"sql":"binary"},"users.dateColumn":{"sql":"date"},"users.timestampColumn":{"sql":"timestamp"},"users.fatherId":{"sql":"fatherId"},"accounts":{"sql":"prefix_1_accounts"},"accounts.id":{"sql":"secret_id"},"accounts.email":{"sql":"email"}}' where "key" = 'name-variants';
/* --- */
PRAGMA defer_foreign_keys = ON;

drop index if exists "unique_c_users_email";

drop index if exists "unique_c_users_fatherId";

create table "prefix_2_users" ("id" text not null primary key, "name" text not null, "email" text not null, "image" text);

drop index if exists "unique_c_accounts_email";

create table "prefix_2_accounts" ("secret_id" text not null primary key, "email" text not null);

create unique index "id_email_uk" on "prefix_2_accounts" ("secret_id", "email");

INSERT INTO "prefix_2_users" ("id", "name", "email", "image") SELECT "id" as "id", "name" as "name", "email" as "email", "image" as "image" FROM "prefix_1_users";

drop table "prefix_1_users";

INSERT INTO "prefix_2_accounts" ("secret_id", "email") SELECT "secret_id" as "secret_id", "email" as "email" FROM "prefix_1_accounts";

drop table "prefix_1_accounts";

update "private_test_settings" set "value" = '3.0.0' where "key" = 'version';

update "private_test_settings" set "value" = '{"users":{"sql":"prefix_2_users"},"users.id":{"sql":"id"},"users.name":{"sql":"name"},"users.email":{"sql":"email"},"users.image":{"sql":"image"},"accounts":{"sql":"prefix_2_accounts"},"accounts.id":{"sql":"secret_id"},"accounts.email":{"sql":"email"}}' where "key" = 'name-variants';
/* --- */
PRAGMA defer_foreign_keys = ON;

create table "prefix_3_users" ("id" text not null primary key, "name" text not null, "image" integer);

INSERT INTO "prefix_3_users" ("id", "name", "image") SELECT "id" as "id", "name" as "name", "image" as "image" FROM "prefix_2_users";

drop table "prefix_2_users";

update "private_test_settings" set "value" = '4.0.0' where "key" = 'version';

update "private_test_settings" set "value" = '{"users":{"sql":"prefix_3_users"},"users.id":{"sql":"id"},"users.name":{"sql":"name"},"users.image":{"sql":"image"}}' where "key" = 'name-variants';
