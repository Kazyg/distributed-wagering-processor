import { Migration } from '@mikro-orm/migrations';

export class Migration20261011003026_protect_wallet_ledger extends Migration {
  override name = 'Migration20261011003026_protect_wallet_ledger';

  async up(): Promise<void> {
    this.addSql(`
    CREATE FUNCTION public.prevent_wallet_ledger_mutation()
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
    CREATE TRIGGER trg_wallet_ledger_immutable
    BEFORE UPDATE OR DELETE OR TRUNCATE
    ON public.wallet_ledger_entries
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.prevent_wallet_ledger_mutation();
  `);
  }

  async down(): Promise<void> {
    this.addSql(`
    DROP TRIGGER trg_wallet_ledger_immutable
    ON public.wallet_ledger_entries;
  `);

    this.addSql(`
    DROP FUNCTION public.prevent_wallet_ledger_mutation();
  `);
  }
}
