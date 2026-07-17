export type HumanPlusActor = { kind: "human" | "agent" | "system"; id: string; name?: string };
export type HumanPlusPriority = "background" | "normal" | "attention" | "blocking";
export type HumanPlusDisposition = "seen" | "handled" | "rejected" | "ignored";

export interface HumanPlusEvent<T = unknown> {
  id: string;
  sequence: number;
  timestamp: number;
  appId: string;
  surfaceId: string;
  sessionId?: string;
  type: string;
  payload: T;
  actor: HumanPlusActor;
  priority: HumanPlusPriority;
  correlationId?: string;
  causationId?: string;
}
export type NewHumanPlusEvent<T = unknown> = Omit<HumanPlusEvent<T>, "id" | "sequence" | "timestamp"> & Partial<Pick<HumanPlusEvent<T>, "id" | "timestamp">>;
export interface HumanPlusEventQuery { consumerId: string; after?: number; limit?: number; unacknowledgedOnly?: boolean; types?: string[]; surfaces?: string[]; }
export interface HumanPlusEventPage { events: HumanPlusEvent[]; nextCursor: number; }
export type HumanPlusEventListener = (event: HumanPlusEvent) => void;

export interface HumanPlusEventStore {
  append(event: NewHumanPlusEvent): Promise<HumanPlusEvent>;
  list(query: HumanPlusEventQuery): Promise<HumanPlusEventPage>;
  acknowledge(consumerId: string, eventIds: string[], disposition: HumanPlusDisposition): Promise<void>;
  subscribe(listener: HumanPlusEventListener): () => void;
  compact?(options?: { before?: number; keepLast?: number }): Promise<void>;
}

export class MemoryHumanPlusEventStore implements HumanPlusEventStore {
  protected events: HumanPlusEvent[] = [];
  protected acknowledgements = new Map<string, Map<string, HumanPlusDisposition>>();
  protected listeners = new Set<HumanPlusEventListener>();
  protected nextSequence = 1;

  async append(input: NewHumanPlusEvent): Promise<HumanPlusEvent> {
    const event: HumanPlusEvent = { ...input, id: input.id ?? globalThis.crypto.randomUUID(), timestamp: input.timestamp ?? Date.now(), sequence: this.nextSequence++ };
    this.events.push(event); this.listeners.forEach((listener) => listener(event)); return event;
  }
  async list(query: HumanPlusEventQuery): Promise<HumanPlusEventPage> {
    const acknowledged = this.acknowledgements.get(query.consumerId);
    const events = this.events.filter((event) => event.sequence > (query.after ?? 0)
      && (!query.unacknowledgedOnly || !acknowledged?.has(event.id))
      && (!query.types?.length || query.types.includes(event.type))
      && (!query.surfaces?.length || query.surfaces.includes(event.surfaceId)))
      .slice(0, Math.max(1, Math.min(500, query.limit ?? 50)));
    return { events, nextCursor: events.at(-1)?.sequence ?? query.after ?? 0 };
  }
  async acknowledge(consumerId: string, eventIds: string[], disposition: HumanPlusDisposition): Promise<void> {
    let values = this.acknowledgements.get(consumerId); if (!values) { values = new Map(); this.acknowledgements.set(consumerId, values); }
    eventIds.forEach((id) => values!.set(id, disposition));
  }
  subscribe(listener: HumanPlusEventListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async compact(options: { before?: number; keepLast?: number } = {}): Promise<void> {
    const cutoff = options.before ?? Number.POSITIVE_INFINITY; const keep = options.keepLast ?? 1000;
    const removable = Math.max(0, this.events.length - keep);
    this.events = this.events.filter((event, index) => index >= removable || event.timestamp >= cutoff);
    const ids = new Set(this.events.map((event) => event.id));
    for (const values of this.acknowledgements.values()) for (const id of values.keys()) if (!ids.has(id)) values.delete(id);
  }
}
