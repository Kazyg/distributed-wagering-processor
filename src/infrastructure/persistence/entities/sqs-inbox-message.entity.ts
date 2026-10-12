import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'sqs_inbox_messages' })
export class SqsInboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({
    type: 'string',
    length: 64,
    fieldName: 'payload_sha256',
  })
  payloadHash!: string;

  @Property({
    type: 'datetime',
    fieldName: 'processed_at',
  })
  processedAt: Date = new Date();
}
