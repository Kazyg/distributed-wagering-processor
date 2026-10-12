import { Migration } from '@mikro-orm/migrations';

export class Migration20261012131602_create_wager_outbox extends Migration {

  override name = 'Migration20261012131602_create_wager_outbox';

  override up(): void | Promise<void> {
    this.addSql(`create table "wager_outbox_events" ("id" bigserial primary key, "event_id" uuid not null, "transaction_id" uuid not null, "wallet_id" uuid not null, "payload" jsonb not null, "created_at" timestamptz not null, "published_at" timestamptz null, "attempt_count" int not null default 0, "next_attempt_at" timestamptz not null, "claim_token" uuid null, "claimed_until" timestamptz null, "last_error" text null);`);
    this.addSql(`alter table "wager_outbox_events" add constraint "wager_outbox_events_event_id_unique" unique ("event_id");`);
    this.addSql(`create index "idx_wager_outbox_wallet_order" on "wager_outbox_events" ("wallet_id", "id") where published_at IS NULL;`);
    this.addSql(`create index "idx_wager_outbox_due" on "wager_outbox_events" ("next_attempt_at") where published_at IS NULL;`);
    this.addSql(`alter table "wager_outbox_events" add constraint "uq_wager_outbox_transaction" unique ("transaction_id");`);

    this.addSql(`alter table "wager_outbox_events" add constraint "wager_outbox_events_transaction_id_foreign" foreign key ("transaction_id") references "wager_transactions" ("id") on delete restrict;`);
    this.addSql(`alter table "wager_outbox_events" add constraint "wager_outbox_events_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id") on delete restrict;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "wager_outbox_events" cascade;`);
  }

}
