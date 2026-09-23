-- fumadb-effect deviation: text columns are nvarchar (varchar is a single-byte codepage type and turns non-Latin1 text into '?'); timestamp is datetime2(3) (datetime rounds to 3.33 ms ticks).
-- The `from-database` migration script this package generates for MSSQL.
-- Compared against test/snapshots/upstream/migration/kysely.mssql-from-database.sql
-- (the script upstream fumadb produced through Kysely), it differs in five
-- places. The first three are DDL corrections shared with `from-schema`, and
-- the last two come from src/sql/introspect.ts.
--
-- fumadb-effect deviation: every `alter column` restates the nullability.
-- T-SQL makes a column NULLable when `ALTER COLUMN c <type>` leaves it out, so
-- upstream's three bare `alter column` lines silently dropped `NOT NULL`
-- (confirmed against INFORMATION_SCHEMA.COLUMNS on the live container).
--
-- fumadb-effect deviation: a `decimal` column is created as `decimal(38,19)`.
-- A bare `decimal` is DECIMAL(18, 0) on SQL Server, which rounds 1.5 to 2.
--
-- fumadb-effect deviation: every `drop column` is preceded by the
-- `DECLARE @ConstraintName` lookup that drops the column's default constraint.
-- SQL Server refuses to drop a column a default constraint still references,
-- and it names that constraint implicitly, so it cannot be dropped by name.
-- Upstream emitted a bare `dropColumn`, which fails on any defaulted column
-- ("The object 'DF__accounts__email__...' is dependent on column 'email'"); the
-- fixture hits it when 2.0.0 is rolled back to 1.0.0. The lookup is a no-op
-- when the column has no default, so the twelve blocks below only add text.
--
-- fumadb-effect deviation: step 3 drops the default constraints of
-- "prefix_2_users"."image" and "prefix_2_accounts"."email". 3.0.0 removes both
-- defaults. Upstream's MSSQL introspection did not read `sys.default_constraints`,
-- so it saw no default change and left both `DF_` constraints in the database.
-- The two `DECLARE @ConstraintName` blocks below are the same ones upstream's
-- own `from-schema` plan emits for that step (kysely.mssql-from-schema.sql).
--
-- fumadb-effect deviation: the ten `drop column` statements of step 3 are in
-- the order the columns were created, not in alphabetical order. Upstream's
-- MSSQL introspection sorted columns by name; ours reads `sys.columns ORDER BY
-- column_id`, so the order matches both the schema declaration and upstream's
-- own `from-schema` plan. The statements are independent, so only the text
-- differs.
create table "prefix_0_users" ("id" nvarchar(255) not null primary key, "image" nvarchar(200) default 'my-avatar', "data" varbinary(max));

create table "prefix_0_accounts" ("secret_id" nvarchar(255) not null primary key);

create table "private_test_settings" ("key" varchar(255) primary key, "value" nvarchar(max) not null);

insert into "private_test_settings" ("key", "value") values ('version', '1.0.0');

insert into "private_test_settings" ("key", "value") values ('name-variants', '{"users":{"sql":"prefix_0_users"},"users.id":{"sql":"id"},"users.image":{"sql":"image"},"users.data":{"sql":"data"},"accounts":{"sql":"prefix_0_accounts"},"accounts.id":{"sql":"secret_id"}}');
/* --- */
EXEC sp_rename prefix_0_users, prefix_1_users;

EXEC sp_rename prefix_0_accounts, prefix_1_accounts;

alter table "prefix_1_users" add "name" nvarchar(255) not null;

alter table "prefix_1_users" add "email" nvarchar(255) not null;

DECLARE @ConstraintName NVARCHAR(200);

SELECT @ConstraintName = dc.name
FROM sys.default_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = 'dbo' AND t.name = 'prefix_1_users' AND c.name = 'image';

IF @ConstraintName IS NOT NULL
BEGIN
    EXEC('ALTER TABLE "dbo"."prefix_1_users" DROP CONSTRAINT ' + @ConstraintName);
END;

alter table "prefix_1_users" alter column "image" nvarchar(max) null;

ALTER TABLE "prefix_1_users" ADD CONSTRAINT "DF_prefix_1_users_image" DEFAULT 'another-avatar' FOR "image";

alter table "prefix_1_users" add "string" nvarchar(max);

alter table "prefix_1_users" add "bigint" bigint;

alter table "prefix_1_users" add "integer" int;

alter table "prefix_1_users" add "decimal" decimal(38,19);

alter table "prefix_1_users" add "bool" bit;

alter table "prefix_1_users" add "json" nvarchar(max);

alter table "prefix_1_users" add "binary" varbinary(max);

alter table "prefix_1_users" add "date" date;

alter table "prefix_1_users" add "timestamp" datetime2(3);

alter table "prefix_1_users" add "fatherId" nvarchar(255);

create unique index "unique_c_users_email" on "prefix_1_users" ("email") where "email" is not null;

create unique index "unique_c_users_fatherId" on "prefix_1_users" ("fatherId") where "fatherId" is not null;

alter table "prefix_1_accounts" add "email" nvarchar(255) default 'test' not null;

create unique index "unique_c_accounts_email" on "prefix_1_accounts" ("email") where "email" is not null;

DECLARE @ConstraintName NVARCHAR(200);

SELECT @ConstraintName = dc.name
FROM sys.default_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = 'dbo' AND t.name = 'prefix_1_users' AND c.name = 'data';

IF @ConstraintName IS NOT NULL
BEGIN
    EXEC('ALTER TABLE "dbo"."prefix_1_users" DROP CONSTRAINT ' + @ConstraintName);
END;

alter table "prefix_1_users" drop column "data";

update "private_test_settings" set "value" = '2.0.0' where "key" = 'version';

update "private_test_settings" set "value" = '{"users":{"sql":"prefix_1_users"},"users.id":{"sql":"id"},"users.name":{"sql":"name"},"users.email":{"sql":"email"},"users.image":{"sql":"image"},"users.stringColumn":{"sql":"string"},"users.bigintColumn":{"sql":"bigint"},"users.integerColumn":{"sql":"integer"},"users.decimalColumn":{"sql":"decimal"},"users.boolColumn":{"sql":"bool"},"users.jsonColumn":{"sql":"json"},"users.binaryColumn":{"sql":"binary"},"users.dateColumn":{"sql":"date"},"users.timestampColumn":{"sql":"timestamp"},"users.fatherId":{"sql":"fatherId"},"accounts":{"sql":"prefix_1_accounts"},"accounts.id":{"sql":"secret_id"},"accounts.email":{"sql":"email"}}' where "key" = 'name-variants';
/* --- */
EXEC sp_rename prefix_1_users, prefix_2_users;

EXEC sp_rename prefix_1_accounts, prefix_2_accounts;

DECLARE @ConstraintName NVARCHAR(200);

SELECT @ConstraintName = dc.name
FROM sys.default_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = 'dbo' AND t.name = 'prefix_2_users' AND c.name = 'image';

IF @ConstraintName IS NOT NULL
BEGIN
    EXEC('ALTER TABLE "dbo"."prefix_2_users" DROP CONSTRAINT ' + @ConstraintName);
END;

drop index if exists "unique_c_users_email" on "prefix_2_users";

drop index if exists "unique_c_users_fatherId" on "prefix_2_users";

DECLARE @ConstraintName NVARCHAR(200);

SELECT @ConstraintName = dc.name
FROM sys.default_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = 'dbo' AND t.name = 'prefix_2_accounts' AND c.name = 'email';

IF @ConstraintName IS NOT NULL
BEGIN
    EXEC('ALTER TABLE "dbo"."prefix_2_accounts" DROP CONSTRAINT ' + @ConstraintName);
END;

create unique index "id_email_uk" on "prefix_2_accounts" ("secret_id", "email") where ("secret_id" is not null and "email" is not null);

drop index if exists "unique_c_accounts_email" on "prefix_2_accounts";

DECLARE @ConstraintName NVARCHAR(200);

SELECT @ConstraintName = dc.name
FROM sys.default_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = 'dbo' AND t.name = 'prefix_2_users' AND c.name = 'string';

IF @ConstraintName IS NOT NULL
BEGIN
    EXEC('ALTER TABLE "dbo"."prefix_2_users" DROP CONSTRAINT ' + @ConstraintName);
END;

alter table "prefix_2_users" drop column "string";

DECLARE @ConstraintName NVARCHAR(200);

SELECT @ConstraintName = dc.name
FROM sys.default_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = 'dbo' AND t.name = 'prefix_2_users' AND c.name = 'bigint';

IF @ConstraintName IS NOT NULL
BEGIN
    EXEC('ALTER TABLE "dbo"."prefix_2_users" DROP CONSTRAINT ' + @ConstraintName);
END;

alter table "prefix_2_users" drop column "bigint";

DECLARE @ConstraintName NVARCHAR(200);

SELECT @ConstraintName = dc.name
FROM sys.default_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = 'dbo' AND t.name = 'prefix_2_users' AND c.name = 'integer';

IF @ConstraintName IS NOT NULL
BEGIN
    EXEC('ALTER TABLE "dbo"."prefix_2_users" DROP CONSTRAINT ' + @ConstraintName);
END;

alter table "prefix_2_users" drop column "integer";

DECLARE @ConstraintName NVARCHAR(200);

SELECT @ConstraintName = dc.name
FROM sys.default_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = 'dbo' AND t.name = 'prefix_2_users' AND c.name = 'decimal';

IF @ConstraintName IS NOT NULL
BEGIN
    EXEC('ALTER TABLE "dbo"."prefix_2_users" DROP CONSTRAINT ' + @ConstraintName);
END;

alter table "prefix_2_users" drop column "decimal";

DECLARE @ConstraintName NVARCHAR(200);

SELECT @ConstraintName = dc.name
FROM sys.default_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = 'dbo' AND t.name = 'prefix_2_users' AND c.name = 'bool';

IF @ConstraintName IS NOT NULL
BEGIN
    EXEC('ALTER TABLE "dbo"."prefix_2_users" DROP CONSTRAINT ' + @ConstraintName);
END;

alter table "prefix_2_users" drop column "bool";

DECLARE @ConstraintName NVARCHAR(200);

SELECT @ConstraintName = dc.name
FROM sys.default_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = 'dbo' AND t.name = 'prefix_2_users' AND c.name = 'json';

IF @ConstraintName IS NOT NULL
BEGIN
    EXEC('ALTER TABLE "dbo"."prefix_2_users" DROP CONSTRAINT ' + @ConstraintName);
END;

alter table "prefix_2_users" drop column "json";

DECLARE @ConstraintName NVARCHAR(200);

SELECT @ConstraintName = dc.name
FROM sys.default_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = 'dbo' AND t.name = 'prefix_2_users' AND c.name = 'binary';

IF @ConstraintName IS NOT NULL
BEGIN
    EXEC('ALTER TABLE "dbo"."prefix_2_users" DROP CONSTRAINT ' + @ConstraintName);
END;

alter table "prefix_2_users" drop column "binary";

DECLARE @ConstraintName NVARCHAR(200);

SELECT @ConstraintName = dc.name
FROM sys.default_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = 'dbo' AND t.name = 'prefix_2_users' AND c.name = 'date';

IF @ConstraintName IS NOT NULL
BEGIN
    EXEC('ALTER TABLE "dbo"."prefix_2_users" DROP CONSTRAINT ' + @ConstraintName);
END;

alter table "prefix_2_users" drop column "date";

DECLARE @ConstraintName NVARCHAR(200);

SELECT @ConstraintName = dc.name
FROM sys.default_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = 'dbo' AND t.name = 'prefix_2_users' AND c.name = 'timestamp';

IF @ConstraintName IS NOT NULL
BEGIN
    EXEC('ALTER TABLE "dbo"."prefix_2_users" DROP CONSTRAINT ' + @ConstraintName);
END;

alter table "prefix_2_users" drop column "timestamp";

DECLARE @ConstraintName NVARCHAR(200);

SELECT @ConstraintName = dc.name
FROM sys.default_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = 'dbo' AND t.name = 'prefix_2_users' AND c.name = 'fatherId';

IF @ConstraintName IS NOT NULL
BEGIN
    EXEC('ALTER TABLE "dbo"."prefix_2_users" DROP CONSTRAINT ' + @ConstraintName);
END;

alter table "prefix_2_users" drop column "fatherId";

update "private_test_settings" set "value" = '3.0.0' where "key" = 'version';

update "private_test_settings" set "value" = '{"users":{"sql":"prefix_2_users"},"users.id":{"sql":"id"},"users.name":{"sql":"name"},"users.email":{"sql":"email"},"users.image":{"sql":"image"},"accounts":{"sql":"prefix_2_accounts"},"accounts.id":{"sql":"secret_id"},"accounts.email":{"sql":"email"}}' where "key" = 'name-variants';
/* --- */
EXEC sp_rename prefix_2_users, prefix_3_users;

DECLARE @ConstraintName NVARCHAR(200);

SELECT @ConstraintName = dc.name
FROM sys.default_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = 'dbo' AND t.name = 'prefix_3_users' AND c.name = 'name';

IF @ConstraintName IS NOT NULL
BEGIN
    EXEC('ALTER TABLE "dbo"."prefix_3_users" DROP CONSTRAINT ' + @ConstraintName);
END;

alter table "prefix_3_users" alter column "name" nvarchar(max) not null;

DECLARE @ConstraintName NVARCHAR(200);

SELECT @ConstraintName = dc.name
FROM sys.default_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = 'dbo' AND t.name = 'prefix_3_users' AND c.name = 'image';

IF @ConstraintName IS NOT NULL
BEGIN
    EXEC('ALTER TABLE "dbo"."prefix_3_users" DROP CONSTRAINT ' + @ConstraintName);
END;

alter table "prefix_3_users" alter column "image" int null;

DECLARE @ConstraintName NVARCHAR(200);

SELECT @ConstraintName = dc.name
FROM sys.default_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = 'dbo' AND t.name = 'prefix_3_users' AND c.name = 'email';

IF @ConstraintName IS NOT NULL
BEGIN
    EXEC('ALTER TABLE "dbo"."prefix_3_users" DROP CONSTRAINT ' + @ConstraintName);
END;

alter table "prefix_3_users" drop column "email";

update "private_test_settings" set "value" = '4.0.0' where "key" = 'version';

update "private_test_settings" set "value" = '{"users":{"sql":"prefix_3_users"},"users.id":{"sql":"id"},"users.name":{"sql":"name"},"users.image":{"sql":"image"}}' where "key" = 'name-variants';
