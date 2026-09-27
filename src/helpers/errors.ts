/**
 * Structured error contract shared by every tool and helper.
 *
 * Tools never throw raw Error objects or stack traces at the caller; they
 * reject with NanitesError so the MCP layer can serialize a structured
 * result instead.
 */
export interface NanitesErrorShape {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export class NanitesError extends Error implements NanitesErrorShape {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(shape: NanitesErrorShape) {
    super(shape.message);
    this.name = "NanitesError";
    this.code = shape.code;
    this.retryable = shape.retryable;
    this.details = shape.details;
  }

  toShape(): NanitesErrorShape {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}
