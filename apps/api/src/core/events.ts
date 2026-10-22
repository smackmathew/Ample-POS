import { Injectable } from '@nestjs/common';
import { schema } from '@pos/db';
import { currentContext, currentTenant } from './request-context';

/** Writes audit rows and outbox events inside the current request transaction. */
@Injectable()
export class Events {
  async audit(action: string, target: { type: string; id: string }, data: Record<string, unknown> = {}) {
    const { tx, user } = currentContext();
    await tx.insert(schema.auditLog).values({
      tenantId: currentTenant().tenantId,
      actorUserId: user.userId,
      action,
      targetType: target.type,
      targetId: target.id,
      data,
    });
  }

  /** Published asynchronously by a worker after the transaction commits. */
  async emit(topic: string, payload: Record<string, unknown>) {
    await currentContext().tx.insert(schema.outbox).values({
      tenantId: currentTenant().tenantId,
      topic,
      payload,
    });
  }

  /** Record an audited change and the matching domain event together. */
  async record(action: string, target: { type: string; id: string }, data: Record<string, unknown> = {}) {
    await this.audit(action, target, data);
    await this.emit(action, { [`${target.type}Id`]: target.id, ...data });
  }
}
