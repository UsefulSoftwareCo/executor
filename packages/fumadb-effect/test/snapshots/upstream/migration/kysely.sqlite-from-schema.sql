PRAGMA defer_foreign_keys = ON;

create table "prefix_0_users" ("id" text not null primary key, "image" text default 'my-avatar', "data" blob);

create table "prefix_0_accounts" ("secret_id" text not null primary key);

create table "private_test_settings" ("key" text primary key, "value" text not null);

insert into "private_test_settings" ("key", "value") values ('version', '1.0.0');

insert into "private_test_settings" ("key", "value") values ('name-variants', '{"users":{"convex":"prefix_0_users","drizzle":"prefix_0_users","prisma":"prefix_0_users","mongodb":"prefix_0_users","sql":"prefix_0_users"},"users.id":{"convex":"id","drizzle":"id","prisma":"id","mongodb":"_id","sql":"id"},"users.image":{"convex":"image","drizzle":"image","prisma":"image","mongodb":"image","sql":"image"},"users.data":{"convex":"data","drizzle":"data","prisma":"data","mongodb":"data","sql":"data"},"accounts":{"convex":"prefix_0_accounts","drizzle":"prefix_0_accounts","prisma":"prefix_0_accounts","mongodb":"prefix_0_accounts","sql":"prefix_0_accounts"},"accounts.id":{"convex":"id","drizzle":"id","prisma":"id","mongodb":"_id","sql":"secret_id"}}');
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

update "private_test_settings" set "value" = '{"users":{"convex":"prefix_1_users","drizzle":"prefix_1_users","prisma":"prefix_1_users","mongodb":"prefix_1_users","sql":"prefix_1_users"},"users.id":{"convex":"id","drizzle":"id","prisma":"id","mongodb":"_id","sql":"id"},"users.name":{"convex":"name","drizzle":"name","prisma":"name","mongodb":"name","sql":"name"},"users.email":{"convex":"email","drizzle":"email","prisma":"email","mongodb":"email","sql":"email"},"users.image":{"convex":"image","drizzle":"image","prisma":"image","mongodb":"image","sql":"image"},"users.stringColumn":{"convex":"stringColumn","drizzle":"stringColumn","prisma":"stringColumn","mongodb":"string","sql":"string"},"users.bigintColumn":{"convex":"bigintColumn","drizzle":"bigintColumn","prisma":"bigintColumn","mongodb":"bigint","sql":"bigint"},"users.integerColumn":{"convex":"integerColumn","drizzle":"integerColumn","prisma":"integerColumn","mongodb":"integer","sql":"integer"},"users.decimalColumn":{"convex":"decimalColumn","drizzle":"decimalColumn","prisma":"decimalColumn","mongodb":"decimal","sql":"decimal"},"users.boolColumn":{"convex":"boolColumn","drizzle":"boolColumn","prisma":"boolColumn","mongodb":"bool","sql":"bool"},"users.jsonColumn":{"convex":"jsonColumn","drizzle":"jsonColumn","prisma":"jsonColumn","mongodb":"json","sql":"json"},"users.binaryColumn":{"convex":"binaryColumn","drizzle":"binaryColumn","prisma":"binaryColumn","mongodb":"binary","sql":"binary"},"users.dateColumn":{"convex":"dateColumn","drizzle":"dateColumn","prisma":"dateColumn","mongodb":"date","sql":"date"},"users.timestampColumn":{"convex":"timestampColumn","drizzle":"timestampColumn","prisma":"timestampColumn","mongodb":"timestamp","sql":"timestamp"},"users.fatherId":{"convex":"fatherId","drizzle":"fatherId","prisma":"fatherId","mongodb":"fatherId","sql":"fatherId"},"accounts":{"convex":"prefix_1_accounts","drizzle":"prefix_1_accounts","prisma":"prefix_1_accounts","mongodb":"prefix_1_accounts","sql":"prefix_1_accounts"},"accounts.id":{"convex":"id","drizzle":"id","prisma":"id","mongodb":"_id","sql":"secret_id"},"accounts.email":{"convex":"email","drizzle":"email","prisma":"email","mongodb":"email","sql":"email"}}' where "key" = 'name-variants';
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

update "private_test_settings" set "value" = '{"users":{"convex":"prefix_2_users","drizzle":"prefix_2_users","prisma":"prefix_2_users","mongodb":"prefix_2_users","sql":"prefix_2_users"},"users.id":{"convex":"id","drizzle":"id","prisma":"id","mongodb":"_id","sql":"id"},"users.name":{"convex":"name","drizzle":"name","prisma":"name","mongodb":"name","sql":"name"},"users.email":{"convex":"email","drizzle":"email","prisma":"email","mongodb":"email","sql":"email"},"users.image":{"convex":"image","drizzle":"image","prisma":"image","mongodb":"image","sql":"image"},"accounts":{"convex":"prefix_2_accounts","drizzle":"prefix_2_accounts","prisma":"prefix_2_accounts","mongodb":"prefix_2_accounts","sql":"prefix_2_accounts"},"accounts.id":{"convex":"id","drizzle":"id","prisma":"id","mongodb":"_id","sql":"secret_id"},"accounts.email":{"convex":"email","drizzle":"email","prisma":"email","mongodb":"email","sql":"email"}}' where "key" = 'name-variants';
/* --- */
PRAGMA defer_foreign_keys = ON;

drop table "prefix_2_accounts";

create table "prefix_3_users" ("id" text not null primary key, "name" text not null, "image" integer);

INSERT INTO "prefix_3_users" ("id", "name", "image") SELECT "id" as "id", "name" as "name", "image" as "image" FROM "prefix_2_users";

drop table "prefix_2_users";

update "private_test_settings" set "value" = '4.0.0' where "key" = 'version';

update "private_test_settings" set "value" = '{"users":{"convex":"prefix_3_users","drizzle":"prefix_3_users","prisma":"prefix_3_users","mongodb":"prefix_3_users","sql":"prefix_3_users"},"users.id":{"convex":"id","drizzle":"id","prisma":"id","mongodb":"_id","sql":"id"},"users.name":{"convex":"name","drizzle":"name","prisma":"name","mongodb":"name","sql":"name"},"users.image":{"convex":"image","drizzle":"image","prisma":"image","mongodb":"image","sql":"image"}}' where "key" = 'name-variants';