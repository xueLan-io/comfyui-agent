import { createInterface } from 'node:readline/promises';

/**
 * Human approval for state-changing actions, with "don't ask again" memory.
 *
 * The research notes list "don't-ask-again tool approval" as a core harness
 * capability (docs/research/2026-landscape.md §6). The gate is an interface so
 * the CLI can prompt, tests can auto-decide, and a future MCP host can route the
 * request however it likes.
 */

export interface ApprovalRequest {
  action: string;
  detail: string;
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
}

export interface ApprovalGate {
  request(req: ApprovalRequest): Promise<ApprovalDecision>;
}

export class AutoApproveGate implements ApprovalGate {
  async request(): Promise<ApprovalDecision> {
    return { approved: true };
  }
}

export class DenyAllGate implements ApprovalGate {
  private readonly reason: string;

  constructor(reason = 'Approval is not available in this context.') {
    this.reason = reason;
  }

  async request(): Promise<ApprovalDecision> {
    return { approved: false, reason: this.reason };
  }
}

/**
 * Prompts on stdin for the first mutating action, then remembers the answer for
 * the rest of the run unless the user declines to remember it.
 */
export class InteractiveApprovalGate implements ApprovalGate {
  private remembered: boolean | undefined;
  private readonly out: (line: string) => void;

  constructor(out: (line: string) => void = (line) => process.stdout.write(`${line}\n`)) {
    this.out = out;
  }

  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    if (this.remembered !== undefined) {
      return { approved: this.remembered, reason: 'Remembered from an earlier approval.' };
    }

    this.out('');
    this.out(`⚠  Approval required: ${req.action}`);
    this.out(`   ${req.detail}`);

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question('   Proceed? [y]es / [n]o / [a]lways: '))
        .trim()
        .toLowerCase();
      if (answer === 'a' || answer === 'always') {
        this.remembered = true;
        return { approved: true, reason: 'Approved for the remainder of this run.' };
      }
      if (answer === 'y' || answer === 'yes') return { approved: true };
      return { approved: false, reason: 'Declined by the user.' };
    } finally {
      rl.close();
    }
  }
}

/**
 * Interactive when stdin is a TTY, otherwise deny.
 *
 * Failing closed is the point: a piped or CI invocation must not silently gain
 * permission to spin up GPU work.
 */
export function defaultApprovalGate(options: { assumeYes: boolean; isTTY?: boolean }): ApprovalGate {
  if (options.assumeYes) return new AutoApproveGate();
  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY);
  if (!isTTY) {
    return new DenyAllGate(
      'No interactive terminal available. Re-run with --yes to approve mutating actions, or keep dry-run on.',
    );
  }
  return new InteractiveApprovalGate();
}
