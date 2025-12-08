import { log, warn } from "./utils.js";

export const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // AWS
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: "[AWS_ACCESS_KEY]" },
  { pattern: /[A-Za-z0-9/+=]{40}(?=\s|$|"|')/g, replacement: "[AWS_SECRET_KEY]" },

  // Generic API keys/tokens
  { pattern: /Bearer\s+[A-Za-z0-9\-\._~\+\/]+=*/g, replacement: "[BEARER_TOKEN]" },
  { pattern: /api[_-]?key["\s:=]+["']?[A-Za-z0-9\-_]{20,}["']?/gi, replacement: "[API_KEY]" },
  { pattern: /token["\s:=]+["']?[A-Za-z0-9\-_]{20,}["']?/gi, replacement: "[TOKEN]" },

  // Private keys
  { pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, replacement: "[PRIVATE_KEY]" },

  // Passwords in common formats
  // Matches: "password": "...", password = "...", password='...'
  { pattern: /((?:password|passwd|pwd)["\s]*[:=]["\s]*)(["'])[^"']{8,}\2/gi, replacement: "$1$2[REDACTED]$2" },

  // GitHub tokens
  { pattern: /ghp_[A-Za-z0-9]{36}/g, replacement: "[GITHUB_PAT]" },
  { pattern: /github_pat_[A-Za-z0-9_]{22,}/g, replacement: "[GITHUB_PAT]" },

  // Slack tokens
  { pattern: /xox[baprs]-[A-Za-z0-9-]+/g, replacement: "[SLACK_TOKEN]" },

  // Database URLs with credentials
  { pattern: /(postgres|mysql|mongodb):\/\/[^:]+:[^@]+@/gi, replacement: "$1://[USER]:[PASS]@" }
];

export interface SanitizationConfig {
  enabled: boolean;
  extraPatterns?: RegExp[];
  auditLog?: boolean; // Added for type compatibility
}

export type SecretPattern = { pattern: RegExp; replacement: string };

export function sanitize(
  text: string,
  config: SanitizationConfig = { enabled: true }
): string {
  if (!config.enabled) return text;

  let clean = text;

  // Apply built-in patterns
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    clean = clean.replace(pattern, replacement);
  }

  // Apply extra patterns
  if (config.extraPatterns) {
    for (const pattern of config.extraPatterns) {
      clean = clean.replace(pattern, "[REDACTED_CUSTOM]");
    }
  }

  return clean;
}

export function compileExtraPatterns(patterns: string[]): RegExp[] {
  const valid: RegExp[] = [];
  for (const p of patterns) {
    try {
      valid.push(new RegExp(p, "gi"));
    } catch (e) {
      warn(`[sanitize] Invalid regex pattern: ${p}`);
    }
  }
  return valid;
}

export function verifySanitization(text: string): {
  containsPotentialSecrets: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];
  let detected = false;

  // Heuristics for things we might have missed
  const heuristics = [
    { name: "Potential Key", pattern: /key\s*=\s*[A-Za-z0-9]{20,}/i },
    { name: "Potential Token", pattern: /token\s*=\s*[A-Za-z0-9]{20,}/i },
    { name: "Long Base64", pattern: /[A-Za-z0-9+/]{50,}={0,2}/ },
  ];

  for (const h of heuristics) {
    if (h.pattern.test(text)) {
      detected = true;
      warnings.push(`Found ${h.name}`);
    }
  }

  return { containsPotentialSecrets: detected, warnings };
}
