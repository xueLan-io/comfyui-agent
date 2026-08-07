export function createFakeClock(start = 0) {
  let now = Number(start) || 0;
  const timers = [];

  function runDue() {
    let ran = false;
    for (;;) {
      const index = timers.findIndex(timer => !timer.cancelled && timer.at <= now);
      if (index < 0) return ran;
      const [timer] = timers.splice(index, 1);
      timer.callback();
      ran = true;
    }
  }

  return {
    now: () => now,
    setTimeout(callback, delay = 0) {
      const timer = { at: now + Math.max(0, Number(delay) || 0), callback, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
    tick(milliseconds = 0) { now += Math.max(0, Number(milliseconds) || 0); runDue(); return now; },
    runAll() {
      while (timers.some(timer => !timer.cancelled)) {
        const next = timers.filter(timer => !timer.cancelled).reduce((minimum, timer) => Math.min(minimum, timer.at), Infinity);
        now = next;
        runDue();
      }
      return now;
    },
    pending: () => timers.filter(timer => !timer.cancelled).length,
  };
}
