import { promises as fs } from "fs";
import * as path from "path";
import { createLogger } from "../logger";

const log = createLogger("storage");

/**
 * Tiny durable key/value collection persisted as a single JSON file.
 *
 * Chosen over a database because a HyperAgent node must run on any 24/7 host
 * with zero external dependencies; writes are atomic (write + rename) and
 * serialized per collection so concurrent workers cannot corrupt the file.
 */
export class JsonCollection<T extends { id: string }> {
  private cache = new Map<string, T>();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly seed: () => T[] = () => [],
  ) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as T[];
      for (const item of parsed) this.cache.set(item.id, item);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.error("failed to load collection, starting empty", {
          file: this.file,
          error: (err as Error).message,
        });
      }
      for (const item of this.seed()) this.cache.set(item.id, item);
      await this.flush();
    }
  }

  /**
   * Persist the current snapshot. The write is serialized and, critically, a
   * failed write never poisons the chain: on a free-tier host with a read-only
   * or full disk we log and fall back to in-memory only instead of throwing on
   * every subsequent write (which would crash the workers).
   */
  private async flush(): Promise<void> {
    const snapshot = JSON.stringify([...this.cache.values()], null, 2);
    this.writeChain = this.writeChain.then(async () => {
      try {
        const tmp = `${this.file}.${process.pid}.tmp`;
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await fs.writeFile(tmp, snapshot, "utf8");
        await fs.rename(tmp, this.file);
      } catch (err) {
        log.error("collection write failed; continuing in-memory", {
          file: this.file,
          error: (err as Error).message,
        });
      }
    });
    return this.writeChain;
  }

  async all(): Promise<T[]> {
    await this.ensureLoaded();
    return [...this.cache.values()];
  }

  async get(id: string): Promise<T | undefined> {
    await this.ensureLoaded();
    return this.cache.get(id);
  }

  async find(pred: (item: T) => boolean): Promise<T[]> {
    await this.ensureLoaded();
    return [...this.cache.values()].filter(pred);
  }

  async findOne(pred: (item: T) => boolean): Promise<T | undefined> {
    await this.ensureLoaded();
    return [...this.cache.values()].find(pred);
  }

  async put(item: T): Promise<T> {
    await this.ensureLoaded();
    this.cache.set(item.id, item);
    await this.flush();
    return item;
  }

  async update(id: string, patch: Partial<T>): Promise<T | undefined> {
    await this.ensureLoaded();
    const current = this.cache.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.cache.set(id, next);
    await this.flush();
    return next;
  }

  async remove(id: string): Promise<void> {
    await this.ensureLoaded();
    this.cache.delete(id);
    await this.flush();
  }
}
