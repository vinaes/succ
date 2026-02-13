/**
 * Custom error hierarchy for succ.
 *
 * Provides programmatic error discrimination without parsing message strings.
 * Each subclass carries a `code` string for structured error handling.
 */

/** Base error for all succ errors. Carries a `code` and optional `context`. */
export class SuccError extends Error {
  readonly code: string;
  readonly context?: Record<string, unknown>;

  constructor(message: string, code: string = 'SUCC_ERROR', context?: Record<string, unknown>) {
    super(message);
    this.name = 'SuccError';
    this.code = code;
    this.context = context;
  }
}

/** Configuration errors: invalid config values, missing required settings. */
export class ConfigError extends SuccError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'CONFIG_ERROR', context);
    this.name = 'ConfigError';
  }
}

/** Storage/database errors: connection failures, query errors, constraint violations. */
export class StorageError extends SuccError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'STORAGE_ERROR', context);
    this.name = 'StorageError';
  }
}

/** Validation errors: bad input, precondition failures, argument checks. */
export class ValidationError extends SuccError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', context);
    this.name = 'ValidationError';
  }
}

/** Network/API errors: HTTP failures, timeouts, API response errors. */
export class NetworkError extends SuccError {
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number, context?: Record<string, unknown>) {
    super(message, 'NETWORK_ERROR', context);
    this.name = 'NetworkError';
    this.statusCode = statusCode;
  }
}

/** Resource not found: files, PRDs, sessions, memories. */
export class NotFoundError extends SuccError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'NOT_FOUND', context);
    this.name = 'NotFoundError';
  }
}

/** Dependency errors: missing optional deps, runtime init failures. */
export class DependencyError extends SuccError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'DEPENDENCY_ERROR', context);
    this.name = 'DependencyError';
  }
}

/** Type guard: check if an error is a SuccError or subclass. */
export function isSuccError(error: unknown): error is SuccError {
  return error instanceof SuccError;
}
