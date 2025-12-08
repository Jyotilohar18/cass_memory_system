import fs from "node:fs/promises";
import { expandPath } from "./utils.js";

/** Maximum age in milliseconds for a lock file before it's considered stale */
const STALE_LOCK_THRESHOLD_MS = 30_000; // 30 seconds

/**
 * Check if a lock file is stale (older than threshold).
 * A stale lock typically means a process crashed while holding it.
 */
async function isLockStale(lockFile: string): Promise<boolean> {
  try {
    const stat = await fs.stat(lockFile);
    const ageMs = Date.now() - stat.mtimeMs;
    return ageMs > STALE_LOCK_THRESHOLD_MS;
  } catch {
    // Lock doesn't exist or can't be read - not stale
    return false;
  }
}

/**
 * Try to clean up a stale lock file.
 * Returns true if lock was removed, false otherwise.
 */
async function tryRemoveStaleLock(lockFile: string): Promise<boolean> {
  try {
    // Double-check staleness before removing
    if (await isLockStale(lockFile)) {
      await fs.unlink(lockFile);
      console.warn(`[lock] Removed stale lock file: ${lockFile}`);
      return true;
    }
  } catch {
    // Failed to remove - another process may have taken it
  }
  return false;
}

/**
 * Simple file lock mechanism for CLI operations.
 * Uses a .lock file next to the target file.
 *
 * Features:
 * - Automatic stale lock detection (>30s old)
 * - Configurable retry count and delay
 * - Stores PID for debugging
 */
export async function withLock<T>(
  targetPath: string,
  operation: () => Promise<T>,
  options: { retries?: number; delay?: number; staleLockThresholdMs?: number } = {}
): Promise<T> {
  const maxRetries = options.retries ?? 20;
  const retryDelay = options.delay ?? 100;
  const lockFile = `${expandPath(targetPath)}.lock`;
  const pid = process.pid.toString();

  // Try to acquire lock
  for (let i = 0; i < maxRetries; i++) {
    try {
      // "wx" fails if file exists
      await fs.writeFile(lockFile, pid, { flag: "wx" });

      // Lock acquired
      try {
        return await operation();
      } finally {
        // Release lock
        try {
          await fs.unlink(lockFile);
        } catch {
          // Ignore error if lock file already gone (shouldn't happen but safe to ignore)
        }
      }
    } catch (err: any) {
      if (err.code === "EEXIST") {
        // Lock exists - check if it's stale
        if (await tryRemoveStaleLock(lockFile)) {
          // Stale lock removed, retry immediately
          continue;
        }
        // Lock is active, wait and retry
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        continue;
      }
      if (err.code === "ENOENT") {
        // Parent directory doesn't exist - create it
        const dir = lockFile.substring(0, lockFile.lastIndexOf("/"));
        await fs.mkdir(dir, { recursive: true });
        continue;
      }
      throw err; // Unexpected error (e.g., EACCES, EROFS)
    }
  }

  throw new Error(`Could not acquire lock for ${targetPath} after ${maxRetries} retries. A .lock file may be held by another process.`);
}