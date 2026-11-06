import {
  isDeliveryZoneRequesterDue,
  OPEN_DELIVERY_ZONE_STATUSES,
  type DeliveryZonePollPolicy,
  type DeliveryZoneRequesterPatch,
  type DeliveryZoneRequesterRow,
  type DeliveryZoneRequesterStatus,
  type DeliveryZoneRequesterStore,
} from '../domain/delivery-zone-requester';

/** Spec fake with the same CAS and open-slot semantics as the Postgres store.
 * Sharing one instance across "restarts" models the durable table. */
export class InMemoryDeliveryZoneRequesterStore implements DeliveryZoneRequesterStore {
  readonly rows = new Map<string, DeliveryZoneRequesterRow>();

  findOpen(
    senderId: string,
    zipCode: string,
  ): Promise<DeliveryZoneRequesterRow | null> {
    for (const row of this.rows.values())
      if (
        row.senderId === senderId &&
        row.zipCode === zipCode &&
        OPEN_DELIVERY_ZONE_STATUSES.includes(row.status)
      )
        return Promise.resolve(structuredClone(row));
    return Promise.resolve(null);
  }

  async createOrGetOpen(
    row: DeliveryZoneRequesterRow,
  ): Promise<DeliveryZoneRequesterRow> {
    const open = await this.findOpen(row.senderId, row.zipCode);
    if (open) return open;
    const existing = this.rows.get(row.sourceRequestId);
    if (existing) return structuredClone(existing);
    this.rows.set(row.sourceRequestId, structuredClone(row));
    return structuredClone(row);
  }

  transition(
    sourceRequestId: string,
    from: DeliveryZoneRequesterStatus,
    patch: DeliveryZoneRequesterPatch,
  ): Promise<DeliveryZoneRequesterRow | null> {
    const live = this.rows.get(sourceRequestId);
    if (!live || live.status !== from) return Promise.resolve(null);
    const next = { ...live, ...structuredClone(patch) };
    this.rows.set(sourceRequestId, next);
    return Promise.resolve(structuredClone(next));
  }

  listDue(
    now: string,
    limit: number,
    policy: DeliveryZonePollPolicy,
  ): Promise<DeliveryZoneRequesterRow[]> {
    const nowMs = Date.parse(now);
    const due = [...this.rows.values()]
      .filter((row) => isDeliveryZoneRequesterDue(row, nowMs, policy))
      .sort(
        (a, b) =>
          (a.lastPolledAt === null ? -1 : Date.parse(a.lastPolledAt)) -
            (b.lastPolledAt === null ? -1 : Date.parse(b.lastPolledAt)) ||
          Date.parse(a.createdAt) - Date.parse(b.createdAt),
      );
    return Promise.resolve(due.slice(0, limit).map((r) => structuredClone(r)));
  }
}
