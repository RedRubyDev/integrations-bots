import Redis from "ioredis";
import { Store } from "../contracts";

export class RedisStore implements Store {
  constructor(private readonly redis: Redis) {}
  get(key: string) { return this.redis.get(`integrations-bots:${key}`); }
  async set(key: string, value: string, options: { ttl?: number; onlyIfAbsent?: boolean } = {}): Promise<boolean> {
    const args: (string | number)[] = [`integrations-bots:${key}`, value];
    if (options.ttl) args.push("EX", options.ttl);
    if (options.onlyIfAbsent) args.push("NX");
    return await this.redis.call("SET", ...args) === "OK";
  }
  async delete(key: string) { await this.redis.del(`integrations-bots:${key}`); }
  async release(key: string, value: string) {
    await this.redis.eval("if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end", 1, `integrations-bots:${key}`, value);
  }
  async scan(prefix: string): Promise<string[]> {
    let cursor = "0"; const keys: string[] = [];
    do {
      const result = await this.redis.scan(cursor, "MATCH", `integrations-bots:${prefix}*`, "COUNT", 100);
      cursor = result[0]; keys.push(...result[1].map((key) => key.slice("integrations-bots:".length)));
    } while (cursor !== "0");
    return keys;
  }
}
