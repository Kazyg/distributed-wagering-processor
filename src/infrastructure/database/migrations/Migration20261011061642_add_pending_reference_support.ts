import { Migration } from '@mikro-orm/migrations';

export class Migration20261011061642_add_pending_reference_support extends Migration {

  override name = 'Migration20261011061642_add_pending_reference_support';

  override up(): void | Promise<void> {
    this.addSql(`alter table "wager_transactions" add "retry_count" int not null default 0, add "next_retry_at" timestamptz null;`);
    this.addSql(`alter table "wager_transactions" alter column "status" type varchar(32) using ("status"::varchar(32));`);
    this.addSql(`create index "idx_wager_pending_retry" on "wager_transactions" ("next_retry_at") where "status" = 'PENDING_REFERENCE';`);
    this.addSql(`alter table "wager_transactions" add constraint "ck_wager_retry_count_nonnegative" check (retry_count >= 0);`);
    this.addSql(`alter table "wager_transactions" add constraint "ck_wager_pending_retry_date" check (
    status <> 'PENDING_REFERENCE'
    OR next_retry_at IS NOT NULL
  );`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop index "idx_wager_pending_retry";`);
    this.addSql(`alter table "wager_transactions" drop constraint "ck_wager_retry_count_nonnegative";`);
    this.addSql(`alter table "wager_transactions" drop constraint "ck_wager_pending_retry_date";`);
    this.addSql(`alter table "wager_transactions" drop column "retry_count", drop column "next_retry_at";`);
    this.addSql(`alter table "wager_transactions" alter column "status" type varchar(16) using ("status"::varchar(16));`);
  }

}
