/**
 * Runaway-generation detector. Monitors an incremental token stream and
 * kills generation on either a hard token ceiling or a streaming-level
 * repetition loop — whichever fires first. It is called per delta so the
 * caller can abort before the request timeout would have fired.
 */
import { findRepetitionTail } from "./repetition.js";

export interface RunawayConfig {
  /** Hard ceiling on total output tokens. */
  maxTokens: number;
  /** How many trailing characters are scanned for repetition. */
  windowChars: number;
  /** Minimum repeated-tail length (chars) that counts as a loop. */
  minLoopChars: number;
}

export interface RunawayVerdict {
  killed: boolean;
  reason?: "max_tokens" | "repetition_loop";
  tokensSeen: number;
}

export class RunawayDetector {
  private readonly config: RunawayConfig;
  private tokensSeen = 0;
  private window = "";

  constructor(config: RunawayConfig) {
    this.config = config;
  }

  get count(): number {
    return this.tokensSeen;
  }

  /**
   * Feed one token/delta (string). Returns a killing verdict when the ceiling
   * or a repetition loop is exceeded; otherwise a non-killing verdict.
   */
  track(token: string): RunawayVerdict {
    this.tokensSeen++;
    if (this.tokensSeen >= this.config.maxTokens) {
      return { killed: true, reason: "max_tokens", tokensSeen: this.tokensSeen };
    }

    this.window = (this.window + token).slice(-this.config.windowChars);
    if (this.window.length < this.config.minLoopChars) {
      return { killed: false, tokensSeen: this.tokensSeen };
    }

    const loop = findRepetitionTail(this.window);
    if (loop && loop.startIndex <= this.window.length - this.config.minLoopChars) {
      return { killed: true, reason: "repetition_loop", tokensSeen: this.tokensSeen };
    }
    return { killed: false, tokensSeen: this.tokensSeen };
  }

  reset(): void {
    this.tokensSeen = 0;
    this.window = "";
  }
}
