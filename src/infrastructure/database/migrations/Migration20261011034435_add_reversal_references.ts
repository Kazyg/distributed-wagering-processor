import { Migration } from '@mikro-orm/migrations';

export class Migration20261011034435_add_reversal_references extends Migration {
  override name = 'Migration20261011034435_add_reversal_references';

  override up(): void | Promise<void> {
    this.addSql(
      `alter table "wager_transactions" add "reference_transaction_id" uuid null, add "reference_external_transaction_id" varchar(128) null;`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_reference_transaction_id_foreign" foreign key ("reference_transaction_id") references "wager_transactions" ("id") on delete restrict;`,
    );
    this.addSql(
      `create unique index "uq_processed_reversal_target" on "wager_transactions" ("reference_transaction_id") where type in ('REFUND', 'ROLLBACK') and status = 'PROCESSED';`,
    );

    this.addSql(`drop trigger if exists "trg_wallet_ledger_immutable" on "wallet_ledger_entries";`);
    this.addSql(
      `drop function if exists "wallet_ledger_entries_trg_wallet_ledger_immutable_fn"();`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(
      `alter table "wager_transactions" drop constraint "wager_transactions_reference_transaction_id_foreign";`,
    );

    this.addSql(`drop index "uq_processed_reversal_target";`);
    this.addSql(
      `alter table "wager_transactions" drop column "reference_transaction_id", drop column "reference_external_transaction_id";`,
    );

    this.addSql(
      `create or replace function "wallet_ledger_entries_trg_wallet_ledger_immutable_fn"() returns trigger as $$ begin ; end; $$ language plpgsql;`,
    );
    this.addSql(
      `create trigger "trg_wallet_ledger_immutable" BEFORE DELETE OR UPDATE on "wallet_ledger_entries" for each STATEMENT execute function "wallet_ledger_entries_trg_wallet_ledger_immutable_fn"();`,
    );
  }
}
