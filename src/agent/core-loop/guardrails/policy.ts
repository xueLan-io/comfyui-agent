import type { GuardrailConfig } from '../config/env.ts';

/**
 * The run's safety envelope, as an object every tool can consult.
 *
 * Dry-run defaults to on (see .env.example): the agent is genuinely useful for
 * graph assembly and validation at zero risk, and real generation is an explicit
 * opt-in. Any tool that could change ComfyUI state must ask this object first.
 */
export class GuardrailPolicy {
  private readonly config: GuardrailConfig;

  constructor(config: GuardrailConfig) {
    this.config = config;
  }

  get dryRun(): boolean {
    return this.config.dryRun;
  }

  get maxSteps(): number {
    return this.config.maxSteps;
  }

  get timeoutMs(): number {
    return this.config.timeoutMs;
  }

  get nodeAllowlist(): readonly string[] {
    return this.config.nodeAllowlist;
  }

  /** Empty allowlist means "allow everything the server knows". */
  isNodeAllowed(classType: string): boolean {
    return this.config.nodeAllowlist.length === 0 || this.config.nodeAllowlist.includes(classType);
  }
}
