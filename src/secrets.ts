/** Values that look like credentials, and personal identifiers a harness writes into its own
 * transcript (Claude Code records the person's email and organization ID). A scan finds the
 * shapes it knows and misses the rest, so everything that reports a scan says so.
 */
interface Pattern { kind: string; regex: RegExp; group?: number }

// Order matters where shapes overlap: the first pattern to match a stretch of text names it.
const patterns: Pattern[] = [
  { kind: 'private-key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'anthropic-key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai-key', regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'github-token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})/g },
  { kind: 'aws-access-key', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: 'slack-token', regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'bearer-token', regex: /\bBearer\s+([A-Za-z0-9._~+/-]{20,}=*)/g, group: 1 },
  // NAME=value and "NAME": "value", also inside JSON-escaped text (\"NAME\": \"value\"). No
  // word boundary before the name: in escaped text it follows a letter, as in `\nDB_PASSWORD`.
  // Names are upper case only, so a match never starts inside an ordinary word.
  { kind: 'secret-assignment', group: 1,
    regex: /[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*\\?["']?\s*[=:]\s*\\?["']?([^\s"'\\]{6,})/g },
  // Claude Code's credential_org line. Only by its name: session IDs are UUIDs too.
  { kind: 'organization-id', group: 1, regex: /organizationUuid\\?["']?\s*:\s*\\?["']?([0-9a-fA-F-]{36})/g },
  // In JSON-escaped text an address can follow `\n`; it starts after the escape, so redacting it
  // never takes the escape's letter and leaves the JSON valid.
  { kind: 'email-address', regex: /(?:(?<=\\[nrt])|(?<![\w.%+\\-]))[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g },
];

/** Values that are clearly not secrets: references, placeholders, plain settings, and
 * addresses that name no one (examples, no-reply senders, git's own SSH user).
 */
function placeholder(value: string): boolean {
  return /^[$<{%(*[]/.test(value) || /^\d+$/.test(value) || /^(?:true|false|null|none|undefined)$/i.test(value)
    || /^(?:git@|no-?reply@)|@(?:[\w-]+\.)*example\.(?:com|org|net)$|@users\.noreply\.github\.com$/i.test(value);
}

export interface SecretMatch { kind: string; value: string; index: number }

export function scanSecrets(text: string): SecretMatch[] {
  const found: SecretMatch[] = [];
  for (const { kind, regex, group } of patterns) {
    for (const match of text.matchAll(regex)) {
      const value = group ? match[group]! : match[0];
      const index = match.index! + match[0].lastIndexOf(value);
      if (placeholder(value)) continue;
      if (found.some(other => index < other.index + other.value.length && other.index < index + value.length)) continue;
      found.push({ kind, value, index });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/** Enough of a value to recognize it, never enough to use it: a long key shows its
 * well-known prefix and last four characters, anything shorter only its first two.
 */
export function maskSecret(value: string): string {
  if (value.startsWith('-----BEGIN')) return value.slice(0, value.indexOf('-----', 5) + 5) + '…';
  return value.length >= 25 ? `${value.slice(0, 6)}…${value.slice(-4)}` : `${value.slice(0, 2)}…`;
}

export const redactionMarker = (kind: string) => `[redacted by sender: ${kind}]`;

/** Replace every occurrence of each value. Longer values first, so one value inside
 * another is never left half-replaced.
 */
export function redactSecrets(text: string, values: Map<string, string>): string {
  let result = text;
  for (const [value, kind] of [...values].sort(([a], [b]) => b.length - a.length)) result = result.split(value).join(redactionMarker(kind));
  return result;
}
