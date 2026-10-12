import { Migration } from '@mikro-orm/migrations';

export class Migration20261012173543_harden_ledger_integrity extends Migration {
  override name = 'Migration20261012173543_harden_ledger_integrity';

  override up(): void {
    this.addSql(`
    ALTER TABLE public.wager_transactions
    ADD CONSTRAINT uq_wager_transaction_id_wallet
    UNIQUE (id, wallet_id);
  `);
    this.addSql(`
    CREATE UNIQUE INDEX uq_ledger_one_opening_per_wallet
    ON public.wallet_ledger_entries (wallet_id)
    WHERE operation = 'OPENING';
  `);
    this.addSql(`
    ALTER TABLE public.wallet_ledger_entries
    ADD CONSTRAINT ck_ledger_reference_by_operation
    CHECK (
      (
        operation = 'OPENING'
        AND transaction_id IS NULL
      )
      OR
      (
        operation <> 'OPENING'
        AND transaction_id IS NOT NULL
      )
    )
    NOT VALID;
  `);
    this.addSql(`
    ALTER TABLE public.wallet_ledger_entries
    ADD CONSTRAINT fk_ledger_transaction_same_wallet
    FOREIGN KEY (transaction_id, wallet_id)
    REFERENCES public.wager_transactions (id, wallet_id)
    MATCH SIMPLE
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
    NOT VALID;
  `);
    this.addSql(`
    ALTER TABLE public.wallet_ledger_entries
    VALIDATE CONSTRAINT ck_ledger_reference_by_operation;
  `);

    this.addSql(`
    ALTER TABLE public.wallet_ledger_entries
    VALIDATE CONSTRAINT fk_ledger_transaction_same_wallet;
  `);
  }

  override down(): void {
    this.addSql(`
    ALTER TABLE public.wallet_ledger_entries
    DROP CONSTRAINT fk_ledger_transaction_same_wallet;
  `);

    this.addSql(`
    ALTER TABLE public.wallet_ledger_entries
    DROP CONSTRAINT ck_ledger_reference_by_operation;
  `);

    this.addSql(`
    DROP INDEX public.uq_ledger_one_opening_per_wallet;
  `);

    this.addSql(`
    ALTER TABLE public.wager_transactions
    DROP CONSTRAINT uq_wager_transaction_id_wallet;
  `);
  }
}
