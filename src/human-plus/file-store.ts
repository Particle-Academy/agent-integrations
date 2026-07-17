import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MemoryHumanPlusEventStore, type HumanPlusDisposition, type HumanPlusEvent, type NewHumanPlusEvent } from "./events";

type JournalRecord = { kind: "event"; event: HumanPlusEvent } | { kind: "ack"; consumerId: string; eventIds: string[]; disposition: HumanPlusDisposition };

/** Single-process append-only JSONL store for local terminal applications. */
export class FileHumanPlusEventStore extends MemoryHumanPlusEventStore {
  private ready: Promise<void>;
  private writes = Promise.resolve();
  constructor(private readonly path: string) { super(); this.ready = this.load(); }
  private async load() {
    let source = ""; try { source = await readFile(this.path, "utf8"); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    for (const line of source.split("\n")) {
      if (!line.trim()) continue;
      try { const record = JSON.parse(line) as JournalRecord; if (record.kind === "event") { this.events.push(record.event); this.nextSequence = Math.max(this.nextSequence, record.event.sequence + 1); } else await super.acknowledge(record.consumerId, record.eventIds, record.disposition); } catch { /* isolate truncated/corrupt records */ }
    }
  }
  private enqueue(record: JournalRecord) {
    this.writes = this.writes.then(async () => { await mkdir(dirname(this.path), { recursive: true }); const handle = await open(this.path, "a"); try { await handle.appendFile(`${JSON.stringify(record)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); } });
    return this.writes;
  }
  override async append(input: NewHumanPlusEvent) { await this.ready; const event = await super.append(input); await this.enqueue({ kind: "event", event }); return event; }
  override async list(query: Parameters<MemoryHumanPlusEventStore["list"]>[0]) { await this.ready; await this.writes; return super.list(query); }
  override async acknowledge(consumerId: string, eventIds: string[], disposition: HumanPlusDisposition) { await this.ready; await super.acknowledge(consumerId, eventIds, disposition); await this.enqueue({ kind: "ack", consumerId, eventIds, disposition }); }
  override async compact(options: Parameters<MemoryHumanPlusEventStore["compact"]>[0] = {}) {
    await this.ready; await this.writes; await super.compact(options);
    const records: JournalRecord[] = this.events.map((event) => ({ kind: "event", event }));
    for (const [consumerId, values] of this.acknowledgements) for (const [id, disposition] of values) records.push({ kind: "ack", consumerId, eventIds: [id], disposition });
    const temporary = `${this.path}.${process.pid}.tmp`; await mkdir(dirname(this.path), { recursive: true }); await writeFile(temporary, records.map((x) => JSON.stringify(x)).join("\n") + "\n", "utf8"); await rename(temporary, this.path);
  }
}
