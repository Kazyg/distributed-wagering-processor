import { Migration } from '@mikro-orm/migrations';

export class Migration20261010053949 extends Migration {

  override name = 'Migration20261010053949';

  override up(): void | Promise<void> {
    this.addSql(`create table "wallets" ("id" uuid not null, "player_id" varchar(128) not null, "currency" varchar(3) not null, "balance" numeric(18,2) not null default '0.00', "version" int not null default 1, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "wallets" add constraint "wallets_player_id_currency_unique" unique ("player_id", "currency");`);

    this.addSql(`alter table "wallets" add constraint "wallets_check" check (balance >= 0);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "wallets" cascade;`);
  }

}
