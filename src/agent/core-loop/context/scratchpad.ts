/**
 * Structured note-taking — the "agentic memory" technique from the research
 * notes (§2). Notes live outside the message history and are re-injected as a
 * compact block, so the agent keeps its bearings across compaction and long runs.
 *
 * It doubles as the run's checkpoint: `toJSON()` is enough to reconstruct what
 * the agent had learned (docs/research/2026-landscape.md §3, compounding errors).
 */

export type NoteKind = 'plan' | 'fact' | 'decision' | 'issue';

export interface Note {
  kind: NoteKind;
  text: string;
  at: string;
}

const MAX_NOTES = 40;

export class Scratchpad {
  private readonly notes: Note[] = [];

  add(kind: NoteKind, text: string): Note {
    const note: Note = { kind, text, at: new Date().toISOString() };
    this.notes.push(note);
    // Bound growth: oldest low-value notes fall off first.
    if (this.notes.length > MAX_NOTES) this.notes.splice(0, this.notes.length - MAX_NOTES);
    return note;
  }

  all(): readonly Note[] {
    return this.notes;
  }

  get size(): number {
    return this.notes.length;
  }

  /** Render as a compact block for the system context. Empty string when no notes. */
  render(): string {
    if (this.notes.length === 0) return '';
    const lines = this.notes.map((n) => `- (${n.kind}) ${n.text}`);
    return ['<scratchpad>', ...lines, '</scratchpad>'].join('\n');
  }

  toJSON(): Note[] {
    return [...this.notes];
  }

  static fromJSON(notes: readonly Note[]): Scratchpad {
    const pad = new Scratchpad();
    for (const note of notes) pad.notes.push(note);
    return pad;
  }
}
