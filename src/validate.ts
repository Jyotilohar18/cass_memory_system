/**
 * src/validate.ts - Scientific validation for reflector output
 *
 * Validates LLM-generated deltas before applying to playbook
 */

import { z } from 'zod';
import { PlaybookDelta, PlaybookDeltaSchema, PlaybookBullet } from './types.js';
import { warn, log } from './utils.js';

/**
 * Schema for the full reflector output (array of deltas)
 */
const ReflectorOutputSchema = z.array(PlaybookDeltaSchema);

/**
 * Validate and filter reflector output to only valid deltas.
 *
 * @param output - Raw output from LLM (string or parsed object)
 * @param existingBulletIds - Optional set of known bullet IDs for reference validation
 * @returns Array of valid PlaybookDelta objects
 */
export function validateReflectorOutput(
  output: unknown,
  existingBulletIds?: Set<string>
): PlaybookDelta[] {
  // Step 1: Parse JSON if string
  let parsed: unknown;
  if (typeof output === 'string') {
    try {
      parsed = JSON.parse(output);
    } catch (err) {
      warn(`Failed to parse reflector output as JSON: ${err}`);
      return [];
    }
  } else {
    parsed = output;
  }

  // Step 2: Validate against schema
  const result = ReflectorOutputSchema.safeParse(parsed);
  if (!result.success) {
    warn(`Reflector output failed schema validation: ${result.error.message}`);
    // Try to salvage individual deltas
    return salvageValidDeltas(parsed, existingBulletIds);
  }

  // Step 3: Additional validation per delta type
  const validDeltas: PlaybookDelta[] = [];
  for (const delta of result.data) {
    const validation = validateSingleDelta(delta, existingBulletIds);
    if (validation.valid) {
      validDeltas.push(delta);
    } else {
      warn(`Invalid delta skipped: ${validation.reason}`);
    }
  }

  log(`Validated ${validDeltas.length}/${result.data.length} deltas`, true);
  return validDeltas;
}

/**
 * Validate a single delta with type-specific checks.
 */
function validateSingleDelta(
  delta: PlaybookDelta,
  existingBulletIds?: Set<string>
): { valid: boolean; reason?: string } {
  switch (delta.type) {
    case 'add':
      // Verify content and category are non-empty
      if (!delta.bullet.content?.trim()) {
        return { valid: false, reason: 'add delta has empty content' };
      }
      if (!delta.bullet.category?.trim()) {
        return { valid: false, reason: 'add delta has empty category' };
      }
      return { valid: true };

    case 'helpful':
    case 'harmful':
      // Verify bulletId exists if we have reference data
      if (existingBulletIds && !existingBulletIds.has(delta.bulletId)) {
        return { valid: false, reason: `bulletId ${delta.bulletId} not found for ${delta.type}` };
      }
      return { valid: true };

    case 'replace':
      // Verify bulletId and newContent
      if (existingBulletIds && !existingBulletIds.has(delta.bulletId)) {
        return { valid: false, reason: `bulletId ${delta.bulletId} not found for replace` };
      }
      if (!delta.newContent?.trim()) {
        return { valid: false, reason: 'replace delta has empty newContent' };
      }
      return { valid: true };

    case 'deprecate':
      // Verify bulletId exists
      if (existingBulletIds && !existingBulletIds.has(delta.bulletId)) {
        return { valid: false, reason: `bulletId ${delta.bulletId} not found for deprecate` };
      }
      return { valid: true };

    case 'merge':
      // Verify bulletIds and mergedContent
      if (!delta.bulletIds?.length) {
        return { valid: false, reason: 'merge delta has no bulletIds' };
      }
      if (existingBulletIds) {
        for (const id of delta.bulletIds) {
          if (!existingBulletIds.has(id)) {
            return { valid: false, reason: `bulletId ${id} not found for merge` };
          }
        }
      }
      if (!delta.mergedContent?.trim()) {
        return { valid: false, reason: 'merge delta has empty mergedContent' };
      }
      return { valid: true };

    default:
      return { valid: false, reason: `unknown delta type: ${(delta as any).type}` };
  }
}

/**
 * Try to salvage valid deltas from malformed output.
 * Attempts to parse each item individually.
 */
function salvageValidDeltas(
  output: unknown,
  existingBulletIds?: Set<string>
): PlaybookDelta[] {
  if (!Array.isArray(output)) {
    return [];
  }

  const validDeltas: PlaybookDelta[] = [];
  for (const item of output) {
    const result = PlaybookDeltaSchema.safeParse(item);
    if (result.success) {
      const validation = validateSingleDelta(result.data, existingBulletIds);
      if (validation.valid) {
        validDeltas.push(result.data);
      } else {
        log(`Skipped invalid delta: ${validation.reason}`, true);
      }
    } else {
      log(`Skipped malformed delta: ${JSON.stringify(item).slice(0, 100)}`, true);
    }
  }

  if (validDeltas.length > 0) {
    log(`Salvaged ${validDeltas.length} valid deltas from malformed output`, true);
  }

  return validDeltas;
}

/**
 * Extract bullet IDs from an array of bullets for validation.
 */
export function extractBulletIds(bullets: PlaybookBullet[]): Set<string> {
  return new Set(bullets.map(b => b.id));
}

/**
 * Validate that a delta can be safely applied.
 * Used as a final check before mutation.
 */
export function canApplyDelta(
  delta: PlaybookDelta,
  bullets: PlaybookBullet[]
): { canApply: boolean; reason?: string } {
  const ids = extractBulletIds(bullets);
  const validation = validateSingleDelta(delta, ids);
  return { canApply: validation.valid, reason: validation.reason };
}
