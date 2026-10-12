import { Migration } from '@mikro-orm/migrations';

export class Migration20261010170903_create_wallet_ledger_entries extends Migration {

  override name = 'Migration20261010170903_create_wallet_ledger_entries';

  override up(): void | Promise<void> {
    this.addSql(`create table "wallet_ledger_entries" ("id" uuid not null, "wallet_id" uuid not null, "transaction_id" uuid null, "operation" varchar(16) not null, "direction" varchar(6) not null, "amount" numeric(18,2) not null, "balance_before" numeric(18,2) not null, "balance_after" numeric(18,2) not null, "occurred_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_wallet_id_transaction_id_unique" unique ("wallet_id", "transaction_id");`);

    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id") on delete restrict;`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "ck_wallet_ledger_balance_consistency" check (
    (direction = 'CREDIT' AND balance_after = balance_before + amount)
    OR
    (direction = 'DEBIT' AND balance_after = balance_before - amount)
  );`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "ck_wallet_ledger_balances_nonnegative" check (balance_before >= 0 AND balance_after >= 0);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "ck_wallet_ledger_amount_positive" check (amount > 0);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "wallet_ledger_entries" cascade;`);
  }

}
