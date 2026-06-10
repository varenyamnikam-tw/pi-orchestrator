import * as crypto from "node:crypto";

const MAX_ENTRIES = 200;
const entries = new Map<string, string>();
const pathIndex = new Map<string, Set<string>>(); // filePath → Set<cacheKey>

export function computeCacheKey(
  toolName: string,
  input: Record<string, unknown>,
  rawContent: string
): string {
  return crypto
    .createHash("sha256")
    .update(toolName)
    .update(JSON.stringify(input))
    .update(rawContent)
    .digest("hex")
    .slice(0, 16);
}

export function get(key: string): string | undefined {
  return entries.get(key);
}

export function set(key: string, value: string, filePath?: string): void {
  if (entries.size >= MAX_ENTRIES) {
    entries.delete(entries.keys().next().value!);
  }
  entries.set(key, value);
  if (filePath) {
    if (!pathIndex.has(filePath)) pathIndex.set(filePath, new Set());
    pathIndex.get(filePath)!.add(key);
  }
}

export function invalidatePath(filePath: string): void {
  const keys = pathIndex.get(filePath);
  if (!keys) return;
  for (const key of keys) entries.delete(key);
  pathIndex.delete(filePath);
}

export function clear(): void {
  entries.clear();
  pathIndex.clear();
}
