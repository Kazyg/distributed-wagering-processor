import { Migration } from '@mikro-orm/migrations';

export class Migration20261010182210_create_wager_transactions extends Migration {

  override name = 'Migration20261010182210_create_wager_transactions';

  override up(): void | Promise<void> {
    this.addSql(`create table "wager_transactions" ("id" uuid not null, "wallet_id" uuid not null, "provider_id" varchar(128) not null, "external_transaction_id" varchar(128) not null, "type" varchar(10) not null default 'BET', "amount" numeric(18,2) not null, "currency" varchar(3) not null, "status" varchar(16) not null, "reason" varchar(32) null, "balance_after" numeric(18,2) not null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "wager_transactions" add constraint "uq_wager_provider_external" unique ("provider_id", "external_transaction_id");`);

    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id") on delete restrict;`);
    this.addSql(`alter table "wager_transactions" add constraint "ck_wager_amount_positive" check (amount > 0);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "wager_transactions" cascade;`);
  }

}
