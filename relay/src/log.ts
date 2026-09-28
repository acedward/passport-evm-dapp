// Structured JSON logs that never contain a secret.
//
// Two layers of redaction run on every record:
//   1. by KEY: any field whose name looks sensitive (seed, secret, mnemonic, private key,
//      password, signature, authorization, RPC URL, API key) is replaced, whatever its value;
//   2. by VALUE: every secret the relay loaded (the sponsor seed or mnemonic, the Sepolia RPC
//      URL) is registered here at startup and cut out of every string it appears in, inside
//      messages, nested fields and error texts alike.
// Request bodies are never logged.

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const REDACTED = '[redacted]';
const SENSITIVE_KEY =
  /(seed|secret|mnemonic|private|passw|passphrase|signature|authori[sz]ation|cookie|api_?key|auth_?token|rpc_?url|^sk$|^key$|wallet)/i;
const MIN_SECRET_LENGTH = 8;

export class Redactor {
  private secrets: string[] = [];

  /** Register a secret value; it will be cut out of every logged string. */
  addSecret(value: string | null | undefined): void {
    if (!value) return;
    const variants = new Set([value, value.trim()]);
    // A URL's key usually sits in its path or query: register those parts on their own too.
    try {
      const u = new URL(value.trim());
      if (u.pathname.length >= MIN_SECRET_LENGTH) variants.add(u.pathname);
      if (u.search.length >= MIN_SECRET_LENGTH) variants.add(u.search);
      if (u.password) variants.add(u.password);
    } catch {
      /* not a URL */
    }
    for (const v of variants) if (v.length >= MIN_SECRET_LENGTH && !this.secrets.includes(v)) this.secrets.push(v);
    this.secrets.sort((a, b) => b.length - a.length);
  }

  redactString(s: string): string {
    let out = s;
    for (const secret of this.secrets) if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    return out;
  }

  redact(value: unknown, depth = 0): unknown {
    if (depth > 8) return '[depth]';
    if (typeof value === 'string') return this.redactString(value);
    if (typeof value === 'bigint') return value.toString(10);
    if (value instanceof Error) {
      return {
        name: value.name,
        message: this.redactString(value.message),
        stack: value.stack ? this.redactString(value.stack) : undefined,
      };
    }
    if (Array.isArray(value)) return value.map((v) => this.redact(v, depth + 1));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? REDACTED : this.redact(v, depth + 1);
      return out;
    }
    return value;
  }
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  redactor?: Redactor;
  /** Where each JSON line goes (default: stdout). */
  sink?: (line: string) => void;
  now?: () => Date;
}

export function createLogger(options: LoggerOptions = {}, bound: Record<string, unknown> = {}): Logger {
  const threshold = LOG_LEVELS.indexOf(options.level ?? 'info');
  const redactor = options.redactor ?? new Redactor();
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LOG_LEVELS.indexOf(level) < threshold) return;
    const record = redactor.redact({ ...bound, ...fields }) as Record<string, unknown>;
    sink(JSON.stringify({ t: now().toISOString(), level, msg: redactor.redactString(msg), ...record }));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger(options, { ...bound, ...fields }),
  };
}
