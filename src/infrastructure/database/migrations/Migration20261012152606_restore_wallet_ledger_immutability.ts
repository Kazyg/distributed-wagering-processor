import { Migration } from '@mikro-orm/migrations';

export class Migration20261012152606_restore_wallet_ledger_immutability extends Migration {
  override name = 'Migration20261012152606_restore_wallet_ledger_immutability';

  override up(): void {
    this.addSql(`
    CREATE OR REPLACE FUNCTION public.prevent_wallet_ledger_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $ledger$
    BEGIN
      RAISE EXCEPTION
        'wallet_ledger_entries is append-only: % is not allowed',
        TG_OP
        USING ERRCODE = '55000';
    END;
    $ledger$;
  `);
    this.addSql(`
    CREATE OR REPLACE TRIGGER trg_wallet_ledger_immutable
    BEFORE UPDATE OR DELETE OR TRUNCATE
    ON public.wallet_ledger_entries
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.prevent_wallet_ledger_mutation();
  `);
    this.addSql(`
    ALTER TABLE public.wallet_ledger_entries
    ENABLE TRIGGER trg_wallet_ledger_immutable;
  `);
  }

  override down(): void {
    this.addSql(`
    DROP TRIGGER IF EXISTS trg_wallet_ledger_immutable
    ON public.wallet_ledger_entries;
  `);
  }
}
