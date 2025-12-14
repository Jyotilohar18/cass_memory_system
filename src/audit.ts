import { Config, Playbook, PlaybookBullet, AuditViolation } from "./types.js";
import { cassExport } from "./cass.js";
import { PROMPTS, llmWithFallback, fillPrompt } from "./llm.js"; 
import { z } from "zod";
import { log, warn, truncateForContext } from "./utils.js";

export async function scanSessionsForViolations(
  sessions: string[],
  playbook: Playbook,
  config: Config
): Promise<AuditViolation[]> {
  const violations: AuditViolation[] = [];
  const activeBullets = playbook.bullets.filter(b => !b.deprecated && b.state !== "retired");
  
  const CONCURRENCY = 3;
  const AuditOutputSchema = z.object({
    results: z.array(z.object({
      ruleId: z.string(),
      status: z.enum(["followed", "violated", "not_applicable"]).optional(), // Optional to handle omitted results
      evidence: z.string()
    })),
    summary: z.string().optional()
  });

  // Warn if rule count is high
  if (activeBullets.length > 100) {
    warn(`Audit running with ${activeBullets.length} rules. This may exceed context limits or degrade performance.`);
  }

  // Simple concurrency batching
  for (let i = 0; i < sessions.length; i += CONCURRENCY) {
    const chunk = sessions.slice(i, i + CONCURRENCY);
    
    await Promise.all(chunk.map(async (sessionPath) => {
      try {
        // Pass config to ensure sanitization overrides are respected
        const content = await cassExport(sessionPath, "text", config.cassPath, config);
        if (!content) return;

        // Truncate rules list if necessary (rough estimate: 100 chars per rule)
        // If we have > 200 rules, this string is > 20kb. 
        // For now, simple join is okay as most playbooks are small.
        const rulesList = activeBullets.map(b => `- [${b.id}] ${b.content}`).join("\n");
        
        // Truncate session content to ensure rules fit
        // Reserve 10k chars for rules + overhead if possible
        const maxContentChars = Math.max(5000, 30000 - rulesList.length);
        const safeContent = truncateForContext(content, { maxChars: maxContentChars });

        const prompt = fillPrompt(PROMPTS.audit, {
          sessionContent: safeContent,
          rulesToCheck: rulesList
        });

        // Use fallback for resilience
        const result = await llmWithFallback(
          AuditOutputSchema,
          prompt,
          config
        );

        for (const res of result.results) {
          if (res.status === "violated") {
            const bullet = activeBullets.find(b => b.id === res.ruleId);
            if (bullet) {
              violations.push({
                bulletId: bullet.id,
                bulletContent: bullet.content,
                sessionPath,
                evidence: res.evidence,
                severity: bullet.maturity === "proven" ? "high" : "medium",
                timestamp: new Date().toISOString()
              });
            }
          }
        }

      } catch (e: any) {
        warn(`Audit failed for ${sessionPath}: ${e.message}`);
      }
    }));
  }

  return violations;
}
