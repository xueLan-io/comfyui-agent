export class ProjectMemory {
  constructor(onChange = null) {
    this.onChange = onChange;
    this.current = {
      goal: '',
      workflow: '',
      skillId: '',
      model: '',
      style: '',
      lastPrompt: '',
      lastCompiledPrompt: null,
      lastImages: [],
      assets: [],
      lastResult: null,
      confirmedConstraints: {},
      commonParameters: {},
      savedPreferences: {},
      researchSettings: {},
      metadata: {},
    };
    this.history = [];
  }

  set(field, value) {
    this.current[field] = value;
    this.onChange?.();
  }

  get(field) {
    return this.current[field];
  }

  snapshot() {
    this.history.push({ ...this.current, ts: Date.now() });
    if (this.history.length > 50) this.history.shift();
    this.onChange?.();
  }

  restore(idx = -1) {
    if (this.history.length === 0) return false;
    const snap = idx < 0 ? this.history[this.history.length - 1] : this.history[idx];
    if (snap) {
      const { ts, ...rest } = snap;
      this.current = { ...rest };
      return true;
    }
    return false;
  }

  clear() {
    this.current = {
      goal: '',
      workflow: '',
      skillId: '',
      model: '',
      style: '',
      lastPrompt: '',
      lastCompiledPrompt: null,
      lastImages: [],
      assets: [],
      lastResult: null,
      confirmedConstraints: {},
      commonParameters: {},
      savedPreferences: {},
      researchSettings: {},
      metadata: {},
    };
    this.onChange?.();
  }

  loadFrom(json) {
    if (json?.current && typeof json.current === 'object') {
      this.current = { ...this.current, ...json.current };
    }
    this.history = Array.isArray(json?.history) ? json.history : [];
  }

  toJSON() {
    return { current: this.current, history: this.history };
  }
}
