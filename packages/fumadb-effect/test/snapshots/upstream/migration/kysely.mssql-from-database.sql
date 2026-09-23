create table "prefix_0_users" ("id" varchar(255) not null primary key, "image" varchar(200) default 'my-avatar', "data" varbinary(max));

create table "prefix_0_accounts" ("secret_id" varchar(255) not null primary key);

create table "private_test_settings" ("key" varchar(255) primary key, "value" varchar(max) not null);

insert into "private_test_settings" ("key", "value") values ('version', '1.0.0');

insert into "private_test_settings" ("key", "value") values ('name-variants', '{"users":{"convex":"prefix_0_users","drizzle":"prefix_0_users","prisma":"prefix_0_users","mongodb":"prefix_0_users","sql":"prefix_0_users"},"users.id":{"convex":"id","drizzle":"id","prisma":"id","mongodb":"_id","sql":"id"},"users.image":{"convex":"image","drizzle":"image","prisma":"image","mongodb":"image","sql":"image"},"users.data":{"convex":"data","drizzle":"data","prisma":"data","mongodb":"data","sql":"data"},"accounts":{"convex":"prefix_0_accounts","drizzle":"prefix_0_accounts","prisma":"prefix_0_accounts","mongodb":"prefix_0_accounts","sql":"prefix_0_accounts"},"accounts.id":{"convex":"id","drizzle":"id","prisma":"id","mongodb":"_id","sql":"secret_id"}}');
/* --- */
EXEC sp_rename prefix_0_users, prefix_1_users;

EXEC sp_rename prefix_0_accounts, prefix_1_accounts;

alter table "prefix_1_users" add "name" varchar(255) not null;

alter table "prefix_1_users" add "email" varchar(255) not null;

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

alter table "prefix_1_users" alter column "image" varchar(max);

ALTER TABLE "prefix_1_users" ADD CONSTRAINT "DF_prefix_1_users_image" DEFAULT 'another-avatar' FOR "image";

alter table "prefix_1_users" add "string" varchar(max);

alter table "prefix_1_users" add "bigint" bigint;

alter table "prefix_1_users" add "integer" int;

alter table "prefix_1_users" add "decimal" decimal;

alter table "prefix_1_users" add "bool" bit;

alter table "prefix_1_users" add "json" varchar(max);

alter table "prefix_1_users" add "binary" varbinary(max);

alter table "prefix_1_users" add "date" date;

alter table "prefix_1_users" add "timestamp" datetime;

alter table "prefix_1_users" add "fatherId" varchar(255);

create unique index "unique_c_users_email" on "prefix_1_users" ("email") where "email" is not null;

create unique index "unique_c_users_fatherId" on "prefix_1_users" ("fatherId") where "fatherId" is not null;

alter table "prefix_1_accounts" add "email" varchar(255) default 'test' not null;

create unique index "unique_c_accounts_email" on "prefix_1_accounts" ("email") where "email" is not null;

alter table "prefix_1_users" drop column "data";

update "private_test_settings" set "value" = '2.0.0' where "key" = 'version';

update "private_test_settings" set "value" = '{"users":{"convex":"prefix_1_users","drizzle":"prefix_1_users","prisma":"prefix_1_users","mongodb":"prefix_1_users","sql":"prefix_1_users"},"users.id":{"convex":"id","drizzle":"id","prisma":"id","mongodb":"_id","sql":"id"},"users.name":{"convex":"name","drizzle":"name","prisma":"name","mongodb":"name","sql":"name"},"users.email":{"convex":"email","drizzle":"email","prisma":"email","mongodb":"email","sql":"email"},"users.image":{"convex":"image","drizzle":"image","prisma":"image","mongodb":"image","sql":"image"},"users.stringColumn":{"convex":"stringColumn","drizzle":"stringColumn","prisma":"stringColumn","mongodb":"string","sql":"string"},"users.bigintColumn":{"convex":"bigintColumn","drizzle":"bigintColumn","prisma":"bigintColumn","mongodb":"bigint","sql":"bigint"},"users.integerColumn":{"convex":"integerColumn","drizzle":"integerColumn","prisma":"integerColumn","mongodb":"integer","sql":"integer"},"users.decimalColumn":{"convex":"decimalColumn","drizzle":"decimalColumn","prisma":"decimalColumn","mongodb":"decimal","sql":"decimal"},"users.boolColumn":{"convex":"boolColumn","drizzle":"boolColumn","prisma":"boolColumn","mongodb":"bool","sql":"bool"},"users.jsonColumn":{"convex":"jsonColumn","drizzle":"jsonColumn","prisma":"jsonColumn","mongodb":"json","sql":"json"},"users.binaryColumn":{"convex":"binaryColumn","drizzle":"binaryColumn","prisma":"binaryColumn","mongodb":"binary","sql":"binary"},"users.dateColumn":{"convex":"dateColumn","drizzle":"dateColumn","prisma":"dateColumn","mongodb":"date","sql":"date"},"users.timestampColumn":{"convex":"timestampColumn","drizzle":"timestampColumn","prisma":"timestampColumn","mongodb":"timestamp","sql":"timestamp"},"users.fatherId":{"convex":"fatherId","drizzle":"fatherId","prisma":"fatherId","mongodb":"fatherId","sql":"fatherId"},"accounts":{"convex":"prefix_1_accounts","drizzle":"prefix_1_accounts","prisma":"prefix_1_accounts","mongodb":"prefix_1_accounts","sql":"prefix_1_accounts"},"accounts.id":{"convex":"id","drizzle":"id","prisma":"id","mongodb":"_id","sql":"secret_id"},"accounts.email":{"convex":"email","drizzle":"email","prisma":"email","mongodb":"email","sql":"email"}}' where "key" = 'name-variants';
/* --- */
EXEC sp_rename prefix_1_users, prefix_2_users;

EXEC sp_rename prefix_1_accounts, prefix_2_accounts;

drop index if exists "unique_c_users_email" on "prefix_2_users";

drop index if exists "unique_c_users_fatherId" on "prefix_2_users";

create unique index "id_email_uk" on "prefix_2_accounts" ("secret_id", "email") where ("secret_id" is not null and "email" is not null);

drop index if exists "unique_c_accounts_email" on "prefix_2_accounts";

alter table "prefix_2_users" drop column "bigint";

alter table "prefix_2_users" drop column "binary";

alter table "prefix_2_users" drop column "bool";

alter table "prefix_2_users" drop column "date";

alter table "prefix_2_users" drop column "decimal";

alter table "prefix_2_users" drop column "fatherId";

alter table "prefix_2_users" drop column "integer";

alter table "prefix_2_users" drop column "json";

alter table "prefix_2_users" drop column "string";

alter table "prefix_2_users" drop column "timestamp";

update "private_test_settings" set "value" = '3.0.0' where "key" = 'version';

update "private_test_settings" set "value" = '{"users":{"convex":"prefix_2_users","drizzle":"prefix_2_users","prisma":"prefix_2_users","mongodb":"prefix_2_users","sql":"prefix_2_users"},"users.id":{"convex":"id","drizzle":"id","prisma":"id","mongodb":"_id","sql":"id"},"users.name":{"convex":"name","drizzle":"name","prisma":"name","mongodb":"name","sql":"name"},"users.email":{"convex":"email","drizzle":"email","prisma":"email","mongodb":"email","sql":"email"},"users.image":{"convex":"image","drizzle":"image","prisma":"image","mongodb":"image","sql":"image"},"accounts":{"convex":"prefix_2_accounts","drizzle":"prefix_2_accounts","prisma":"prefix_2_accounts","mongodb":"prefix_2_accounts","sql":"prefix_2_accounts"},"accounts.id":{"convex":"id","drizzle":"id","prisma":"id","mongodb":"_id","sql":"secret_id"},"accounts.email":{"convex":"email","drizzle":"email","prisma":"email","mongodb":"email","sql":"email"}}' where "key" = 'name-variants';
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

alter table "prefix_3_users" alter column "name" varchar(max);

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

alter table "prefix_3_users" alter column "image" int;

alter table "prefix_3_users" drop column "email";

update "private_test_settings" set "value" = '4.0.0' where "key" = 'version';

update "private_test_settings" set "value" = '{"users":{"convex":"prefix_3_users","drizzle":"prefix_3_users","prisma":"prefix_3_users","mongodb":"prefix_3_users","sql":"prefix_3_users"},"users.id":{"convex":"id","drizzle":"id","prisma":"id","mongodb":"_id","sql":"id"},"users.name":{"convex":"name","drizzle":"name","prisma":"name","mongodb":"name","sql":"name"},"users.image":{"convex":"image","drizzle":"image","prisma":"image","mongodb":"image","sql":"image"}}' where "key" = 'name-variants';