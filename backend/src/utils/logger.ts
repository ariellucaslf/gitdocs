export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogContext {
  deliveryId?: string;
  runId?: string;
  stepName?: string;
  repositoryId?: string;
  prNumber?: number;
  workerId?: string;
  durationMs?: number;
  [key: string]: unknown;
}

export interface StructuredLogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  service: string;
  context?: Record<string, unknown>;
}

const SENSITIVE_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /auth/i,
  /password/i,
  /key/i,
  /cookie/i,
];

function redactSensitiveData(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    // Redact Bearer tokens, GitHub tokens, and potential secrets
    return obj
      .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '[REDACTED_GH_TOKEN]')
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED_TOKEN]');
  }

  if (Array.isArray(obj)) {
    return obj.map(redactSensitiveData);
  }

  if (typeof obj === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(k))) {
        sanitized[k] = '[REDACTED]';
      } else {
        sanitized[k] = redactSensitiveData(v);
      }
    }
    return sanitized;
  }

  return obj;
}

export class Logger {
  private service: string;

  constructor(service: string = 'gitdocs') {
    this.service = service;
  }

  private log(level: LogLevel, message: string, context?: LogContext): void {
    const entry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      service: this.service,
    };

    if (context && Object.keys(context).length > 0) {
      entry.context = redactSensitiveData(context) as Record<string, unknown>;
    }

    const output = JSON.stringify(entry);

    if (level === 'error') {
      console.error(output);
    } else if (level === 'warn') {
      console.warn(output);
    } else {
      console.log(output);
    }
  }

  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.log('error', message, context);
  }

  debug(message: string, context?: LogContext): void {
    if (process.env.NODE_ENV !== 'production') {
      this.log('debug', message, context);
    }
  }
}

export const logger = new Logger('gitdocs-backend');

// Provider errors can contain request headers or source bodies. Log only safe classification.
export function logSafeError(message: string, error: unknown, context: LogContext = {}): void {
  const candidate = error as { code?: unknown; status?: unknown } | null;
  logger.error(message, {
    ...context,
    code: typeof candidate?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(candidate.code) ? candidate.code : 'UNCLASSIFIED',
    status: typeof candidate?.status === 'number' ? candidate.status : undefined,
  });
}
