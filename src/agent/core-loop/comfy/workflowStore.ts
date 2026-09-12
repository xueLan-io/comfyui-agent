/**
 * Session-scoped store of built workflows.
 *
 * Why a store rather than passing workflows through tool arguments: a workflow
 * is a large JSON object, and making the model echo it back on every call would
 * burn context and invite transcription errors. Instead `build_workflow` returns
 * a short id and a summary, and later calls reference that id. This is the
 * "own your context window" principle applied to tool ergonomics.
 *
 * It also enforces the safety invariant from AGENTS.md: a workflow can only be
 * submitted if a validation pass was *recorded* against that exact workflow id.
 */

import type { ApiWorkflow } from './workflow.ts';

export interface StoredWorkflow {
  id: string;
  workflow: ApiWorkflow;
  createdAt: string;
  /** Recorded by validate_workflow. Absent means "never validated". */
  validation?: {
    valid: boolean;
    errorCount: number;
    warningCount: number;
    at: string;
  };
}

export interface SubmitReadiness {
  ok: boolean;
  reason?: string;
  hint?: string;
}

export class WorkflowStore {
  private readonly items = new Map<string, StoredWorkflow>();
  private counter = 0;
  private lastId: string | undefined;

  /** Register a built workflow and return its id. */
  add(workflow: ApiWorkflow): StoredWorkflow {
    this.counter += 1;
    const id = `wf_${this.counter}`;
    const item: StoredWorkflow = { id, workflow, createdAt: new Date().toISOString() };
    this.items.set(id, item);
    this.lastId = id;
    return item;
  }

  get(id: string): StoredWorkflow | undefined {
    return this.items.get(id);
  }

  latest(): StoredWorkflow | undefined {
    return this.lastId === undefined ? undefined : this.items.get(this.lastId);
  }

  /** Resolve an explicit id, or fall back to the most recently built workflow. */
  resolve(id?: string): StoredWorkflow | undefined {
    if (id === undefined || id === '') return this.latest();
    return this.items.get(id);
  }

  recordValidation(
    id: string,
    result: { valid: boolean; errors: readonly unknown[]; warnings: readonly unknown[] },
  ): void {
    const item = this.items.get(id);
    if (!item) return;
    item.validation = {
      valid: result.valid,
      errorCount: result.errors.length,
      warningCount: result.warnings.length,
      at: new Date().toISOString(),
    };
  }

  /** Gate consulted by submit_workflow. */
  isSubmittable(id?: string): SubmitReadiness {
    const item = this.resolve(id);
    if (!item) {
      return {
        ok: false,
        reason:
          id === undefined || id === ''
            ? 'No workflow has been built yet.'
            : `No workflow with id "${id}" exists.`,
        hint: 'Call build_workflow first, then validate_workflow.',
      };
    }
    if (!item.validation) {
      return {
        ok: false,
        reason: `Workflow ${item.id} has not been validated.`,
        hint: `Call validate_workflow({ "workflow_id": "${item.id}" }) and make sure it reports VALID.`,
      };
    }
    if (!item.validation.valid) {
      return {
        ok: false,
        reason: `Workflow ${item.id} failed validation with ${item.validation.errorCount} error(s).`,
        hint: 'Fix the reported errors by rebuilding the workflow, then validate again.',
      };
    }
    return { ok: true };
  }

  toJSON(): StoredWorkflow[] {
    return [...this.items.values()];
  }

  get size(): number {
    return this.items.size;
  }
}
