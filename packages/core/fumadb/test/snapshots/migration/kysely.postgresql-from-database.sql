create table "prefix_0_users" ("id" varchar(255) not null primary key, "image" varchar(200) default 'my-avatar', "data" bytea);

create table "prefix_0_accounts" ("secret_id" varchar(255) not null primary key);

create table "private_test_settings" ("key" varchar(255) primary key, "value" text not null);

insert into "private_test_settings" ("key", "value") values ('version', '1.0.0');

insert into "private_test_settings" ("key", "value") values ('name-variants', '{"users":{"convex":"prefix_0_users","drizzle":"prefix_0_users","prisma":"prefix_0_users","mongodb":"prefix_0_users","sql":"prefix_0_users"},"users.id":{"convex":"id","drizzle":"id","prisma":"id","mongodb":"_id","sql":"id"},"users.image":{"convex":"image","drizzle":"image","prisma":"image","mongodb":"image","sql":"image"},"users.data":{"convex":"data","drizzle":"data","prisma":"data","mongodb":"data","sql":"data"},"accounts":{"convex":"prefix_0_accounts","drizzle":"prefix_0_accounts","prisma":"prefix_0_accounts","mongodb":"prefix_0_accounts","sql":"prefix_0_accounts"},"accounts.id":{"convex":"id","drizzle":"id","prisma":"id","mongodb":"_id","sql":"secret_id"}}');
/* --- */
alter table "prefix_0_users" rename to "prefix_1_users";

alter table "prefix_0_accounts" rename to "prefix_1_accounts";

alter table "prefix_1_users" add column "name" varchar(255) not null;

alter table "prefix_1_users" add column "email" varchar(255) not null;

ALTER TABLE "prefix_1_users" ALTER COLUMN "image" TYPE text USING ("image"::text);

alter table "prefix_1_users" alter column "image" set default 'another-avatar';

alter table "prefix_1_users" add column "string" text;

alter table "prefix_1_users" add column "bigint" bigint;

alter table "prefix_1_users" add column "integer" integer;

alter table "prefix_1_users" add column "decimal" decimal;

alter table "prefix_1_users" add column "bool" boolean;

alter table "prefix_1_users" add column "json" json;

alter table "prefix_1_users" add column "binary" bytea;

alter table "prefix_1_users" add column "date" date;

alter table "prefix_1_users" add column "timestamp" timestamp;

alter table "prefix_1_users" add column "fatherId" varchar(255);

alter table "prefix_1_users" add constraint "unique_c_users_email" unique ("email");

alter table "prefix_1_users" add constraint "unique_c_users_fatherId" unique ("fatherId");

alter table "prefix_1_accounts" add column "email" varchar(255) default 'test' not null;

alter table "prefix_1_accounts" add constraint "unique_c_accounts_email" unique ("email");

alter table "prefix_1_users" add constraint "users_accounts_account_fk" foreign key ("email") references "prefix_1_accounts" ("secret_id") on delete cascade on update restrict;

alter table "prefix_1_users" add constraint "users_users_father_fk" foreign key ("fatherId") references "prefix_1_users" ("id") on delete restrict on update restrict;

alter table "prefix_1_users" drop column "data";

update "private_test_settings" set "value" = '2.0.0' where "key" = 'version';

update "private_test_settings" set "value" = '{"users":{"convex":"prefix_1_users","drizzle":"prefix_1_users","prisma":"prefix_1_users","mongodb":"prefix_1_users","sql":"prefix_1_users"},"users.id":{"convex":"id","drizzle":"id","prisma":"id","mongodb":"_id","sql":"id"},"users.name":{"convex":"name","drizzle":"name","prisma":"name","mongodb":"name","sql":"name"},"users.email":{"convex":"email","drizzle":"email","prisma":"email","mongodb":"email","sql":"email"},"users.image":{"convex":"image","drizzle":"image","prisma":"image","mongodb":"image","sql":"image"},"users.stringColumn":{"convex":"stringColumn","drizzle":"stringColumn","prisma":"stringColumn","mongodb":"string","sql":"string"},"users.bigintColumn":{"convex":"bigintColumn","drizzle":"bigintColumn","prisma":"bigintColumn","mongodb":"bigint","sql":"bigint"},"users.integerColumn":{"convex":"integerColumn","drizzle":"integerColumn","prisma":"integerColumn","mongodb":"integer","sql":"integer"},"users.decimalColumn":{"convex":"decimalColumn","drizzle":"decimalColumn","prisma":"decimalColumn","mongodb":"decimal","sql":"decimal"},"users.boolColumn":{"convex":"boolColumn","drizzle":"boolColumn","prisma":"boolColumn","mongodb":"bool","sql":"bool"},"users.jsonColumn":{"convex":"jsonColumn","drizzle":"jsonColumn","prisma":"jsonColumn","mongodb":"json","sql":"json"},"users.binaryColumn":{"convex":"binaryColumn","drizzle":"binaryColumn","prisma":"binaryColumn","mongodb":"binary","sql":"binary"},"users.dateColumn":{"convex":"dateColumn","drizzle":"dateColumn","prisma":"dateColumn","mongodb":"date","sql":"date"},"users.timestampColumn":{"convex":"timestampColumn","drizzle":"timestampColumn","prisma":"timestampColumn","mongodb":"timestamp","sql":"timestamp"},"users.fatherId":{"convex":"fatherId","drizzle":"fatherId","prisma":"fatherId","mongodb":"fatherId","sql":"fatherId"},"accounts":{"convex":"prefix_1_accounts","drizzle":"prefix_1_accounts","prisma":"prefix_1_accounts","mongodb":"prefix_1_accounts","sql":"prefix_1_accounts"},"accounts.id":{"convex":"id","drizzle":"id","prisma":"id","mongodb":"_id","sql":"secret_id"},"accounts.email":{"convex":"email","drizzle":"email","prisma":"email","mongodb":"email","sql":"email"}}' where "key" = 'name-variants';
/* --- */
alter table "prefix_1_users" drop constraint if exists "users_accounts_account_fk";

alter table "prefix_1_users" drop constraint if exists "users_users_father_fk";

alter table "prefix_1_users" rename to "prefix_2_users";

alter table "prefix_1_accounts" rename to "prefix_2_accounts";

alter table "prefix_2_users" alter column "image" drop default;

alter table "prefix_2_users" drop constraint "unique_c_users_email";

alter table "prefix_2_users" drop constraint "unique_c_users_fatherId";

alter table "prefix_2_accounts" alter column "email" drop default;

alter table "prefix_2_accounts" add constraint "id_email_uk" unique ("secret_id", "email");

alter table "prefix_2_accounts" drop constraint "unique_c_accounts_email";

alter table "prefix_2_users" drop column "string";

alter table "prefix_2_users" drop column "bigint";

alter table "prefix_2_users" drop column "integer";

alter table "prefix_2_users" drop column "decimal";

alter table "prefix_2_users" drop column "bool";

alter table "prefix_2_users" drop column "json";

alter table "prefix_2_users" drop column "binary";

alter table "prefix_2_users" drop column "date";

alter table "prefix_2_users" drop column "timestamp";

alter table "prefix_2_users" drop column "fatherId";

update "private_test_settings" set "value" = '3.0.0' where "key" = 'version';

update "private_test_settings" set "value" = '{"users":{"convex":"prefix_2_users","drizzle":"prefix_2_users","prisma":"prefix_2_users","mongodb":"prefix_2_users","sql":"prefix_2_users"},"users.id":{"convex":"id","drizzle":"id","prisma":"id","mongodb":"_id","sql":"id"},"users.name":{"convex":"name","drizzle":"name","prisma":"name","mongodb":"name","sql":"name"},"users.email":{"convex":"email","drizzle":"email","prisma":"email","mongodb":"email","sql":"email"},"users.image":{"convex":"image","drizzle":"image","prisma":"image","mongodb":"image","sql":"image"},"accounts":{"convex":"prefix_2_accounts","drizzle":"prefix_2_accounts","prisma":"prefix_2_accounts","mongodb":"prefix_2_accounts","sql":"prefix_2_accounts"},"accounts.id":{"convex":"id","drizzle":"id","prisma":"id","mongodb":"_id","sql":"secret_id"},"accounts.email":{"convex":"email","drizzle":"email","prisma":"email","mongodb":"email","sql":"email"}}' where "key" = 'name-variants';
/* --- */
alter table "prefix_2_users" rename to "prefix_3_users";

ALTER TABLE "prefix_3_users" ALTER COLUMN "name" TYPE text USING ("name"::text);

ALTER TABLE "prefix_3_users" ALTER COLUMN "image" TYPE integer USING ("image"::integer);

alter table "prefix_3_users" drop column "email";

update "private_test_settings" set "value" = '4.0.0' where "key" = 'version';

update "private_test_settings" set "value" = '{"users":{"convex":"prefix_3_users","drizzle":"prefix_3_users","prisma":"prefix_3_users","mongodb":"prefix_3_users","sql":"prefix_3_users"},"users.id":{"convex":"id","drizzle":"id","prisma":"id","mongodb":"_id","sql":"id"},"users.name":{"convex":"name","drizzle":"name","prisma":"name","mongodb":"name","sql":"name"},"users.image":{"convex":"image","drizzle":"image","prisma":"image","mongodb":"image","sql":"image"}}' where "key" = 'name-variants';