/**
 * Tiny JSON-file cache with per-entry expiry, so a restarted server doesn't
 * refetch thousands of cards. One file per key (sha1 of the key) under
 * CARD_CACHE_DIR. Any read or write problem degrades to a cache miss — the
 * disk cache is an optimisation, never a source of errors.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

interface StoredEntry<V> {
  expiresAt: number;
  value: V;
}

export class DiskCache {
  constructor(
    private dir: string,
    private now: () => number = Date.now,
  ) {}

  private file(key: string): string {
    const hash = createHash("sha1").update(key).digest("hex");
    return path.join(this.dir, hash.slice(0, 2), `${hash}.json`);
  }

  async get<V>(key: string): Promise<V | undefined> {
    try {
      const entry = JSON.parse(await readFile(this.file(key), "utf8")) as StoredEntry<V>;
      if (typeof entry.expiresAt !== "number" || this.now() > entry.expiresAt) return undefined;
      return entry.value;
    } catch {
      return undefined;
    }
  }

  async set<V>(key: string, value: V, ttlMs: number): Promise<void> {
    const file = this.file(key);
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmp, JSON.stringify({ expiresAt: this.now() + ttlMs, value } satisfies StoredEntry<V>), "utf8");
      await rename(tmp, file);
    } catch {
      // Read-only or full disk: carry on without persisting.
    }
  }

  async getOrLoad<V>(key: string, ttlMs: number, loader: () => Promise<V>): Promise<V> {
    const hit = await this.get<V>(key);
    if (hit !== undefined) return hit;
    const value = await loader();
    await this.set(key, value, ttlMs);
    return value;
  }
}
