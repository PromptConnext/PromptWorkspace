import type { SecretsLike, StorageLike } from "../src/session.ts";

export function memorySecrets(): SecretsLike {
  const values = new Map<string, string>();
  return {
    async get(key) {
      return values.get(key);
    },
    async store(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
  };
}

export function memoryState(): StorageLike {
  const values = new Map<string, unknown>();
  return {
    get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async update(key, value) {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    },
  };
}
