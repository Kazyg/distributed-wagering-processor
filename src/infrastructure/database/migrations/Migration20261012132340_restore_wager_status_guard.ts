import { Migration } from '@mikro-orm/migrations';

export class Migration20261012132340_restore_wager_status_guard extends Migration {
  override name = 'Migration20261012132340_restore_wager_status_guard';

  override up(): void {
    this.addSql(`
    CREATE OR REPLACE FUNCTION public.guard_wager_transaction_update()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $guard$
    BEGIN
      IF OLD.status <> 'PENDING_REFERENCE' THEN
        RAISE EXCEPTION
          'Terminal wagering transactions cannot be modified'
          USING ERRCODE = '55000';
      END IF;

      IF OLD.id IS DISTINCT FROM NEW.id
        OR OLD.wallet_id IS DISTINCT FROM NEW.wallet_id
        OR OLD.provider_id IS DISTINCT FROM NEW.provider_id
        OR OLD.external_transaction_id
          IS DISTINCT FROM NEW.external_transaction_id
        OR OLD.type IS DISTINCT FROM NEW.type
        OR OLD.amount IS DISTINCT FROM NEW.amount
        OR OLD.currency IS DISTINCT FROM NEW.currency
        OR OLD.reference_external_transaction_id
          IS DISTINCT FROM NEW.reference_external_transaction_id
        OR OLD.created_at IS DISTINCT FROM NEW.created_at
      THEN
        RAISE EXCEPTION
          'Immutable wagering transaction fields cannot change'
          USING ERRCODE = '55000';
      END IF;

      IF OLD.reference_transaction_id IS NOT NULL
        AND OLD.reference_transaction_id
          IS DISTINCT FROM NEW.reference_transaction_id
      THEN
        RAISE EXCEPTION
          'Referenced transaction cannot be replaced'
          USING ERRCODE = '55000';
      END IF;

      RETURN NEW;
    END;
    $guard$;
  `);

    this.addSql(`
    CREATE OR REPLACE TRIGGER trg_wager_status_guard
    BEFORE UPDATE ON public.wager_transactions
    FOR EACH ROW
    EXECUTE FUNCTION public.guard_wager_transaction_update();
  `);
  }

  override down(): void {
    this.addSql(`
    DROP TRIGGER IF EXISTS trg_wager_status_guard
    ON public.wager_transactions;
  `);
  }
}
