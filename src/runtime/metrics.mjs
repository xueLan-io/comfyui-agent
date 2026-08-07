export function createMetrics({ clock = () => Date.now() } = {}) {
  const counters = new Map();
  const timings = new Map();
  const inc = (name, value = 1) => counters.set(name, (counters.get(name) || 0) + value);
  return {
    increment: inc,
    observe(name, milliseconds) { const item = timings.get(name) || { count: 0, totalMs: 0, maxMs: 0 }; item.count += 1; item.totalMs += Number(milliseconds) || 0; item.maxMs = Math.max(item.maxMs, Number(milliseconds) || 0); timings.set(name, item); },
    start(name) { const started = clock(); return () => { const elapsed = Math.max(0, clock() - started); this.observe(name, elapsed); return elapsed; }; },
    snapshot() { return { counters: Object.fromEntries(counters), timings: Object.fromEntries([...timings].map(([key, value]) => [key, { ...value, averageMs: value.count ? value.totalMs / value.count : 0 }])) }; },
    reset() { counters.clear(); timings.clear(); },
  };
}
