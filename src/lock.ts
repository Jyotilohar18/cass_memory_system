import fs from "node:fs/promises";
import { expandPath } from "./utils.js";

/**
 * Simple file lock mechanism for CLI operations.
 * Uses a .lock file next to the target file.
 */
export async function withLock<T>(
  targetPath: string, 
  operation: () => Promise<T>,
  options: { retries?: number; delay?: number } = {}
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
        } catch (err) {
          // Ignore error if lock file already gone (shouldn't happen but safe to ignore)
        }
      }
    } catch (err: any) {
      if (err.code === "EEXIST") {
        // Check for stale lock (optional: > 10s old?)
        // For simplicity in V1, we just retry.
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        continue;
      }
      throw err; // Unexpected error
    }
  }

  throw new Error(`Could not acquire lock for ${targetPath} after ${maxRetries} retries. Check for stale .lock file.`);
}