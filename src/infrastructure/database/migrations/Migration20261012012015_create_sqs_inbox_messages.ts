import { Migration } from '@mikro-orm/migrations';

export class Migration20261012012015_create_sqs_inbox_messages extends Migration {
  override name = 'Migration20261012012015_create_sqs_inbox_messages';

  override up(): void | Promise<void> {
    this.addSql(
      `create table "sqs_inbox_messages" ("id" uuid not null, "payload_sha256" varchar(64) not null, "processed_at" timestamptz not null, primary key ("id"));`,
    );

    this.addSql(`drop trigger if exists "trg_wager_status_guard" on "wager_transactions";`);
    this.addSql(`drop function if exists "wager_transactions_trg_wager_status_guard_fn"();`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "sqs_inbox_messages" cascade;`);

    this.addSql(
      `create or replace function "wager_transactions_trg_wager_status_guard_fn"() returns trigger as $$ begin ; end; $$ language plpgsql;`,
    );
    this.addSql(
      `create trigger "trg_wager_status_guard" BEFORE UPDATE on "wager_transactions" for each ROW execute function "wager_transactions_trg_wager_status_guard_fn"();`,
    );
  }
}
