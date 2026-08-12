let sharedContext = null;

function getContext() {
  if (!sharedContext) {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return null;
      sharedContext = new AudioContextClass();
    } catch {
      return null;
    }
  }
  return sharedContext;
}

function tone(context, { frequency, start, duration, type = 'sine', gain = 0.2, volume = 1 }) {
  const peak = Math.max(0.0001, gain * volume);
  const oscillator = context.createOscillator();
  const envelope = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, context.currentTime + start);
  envelope.gain.setValueAtTime(0.0001, context.currentTime + start);
  envelope.gain.exponentialRampToValueAtTime(peak, context.currentTime + start + 0.02);
  envelope.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + start + duration);
  oscillator.connect(envelope);
  envelope.connect(context.destination);
  oscillator.start(context.currentTime + start);
  oscillator.stop(context.currentTime + start + duration + 0.05);
}

// 每个风格包含成功（completion）和失败（failure）两套合成音。
const PATTERNS = {
  chime: {
    completion: [{ frequency: 659.25, start: 0, duration: 0.14 }, { frequency: 987.77, start: 0.16, duration: 0.22 }],
    failure: [{ frequency: 233.08, start: 0, duration: 0.2, type: 'triangle' }, { frequency: 174.61, start: 0.22, duration: 0.3, type: 'triangle' }],
  },
  soft: {
    completion: [{ frequency: 523.25, start: 0, duration: 0.25, gain: 0.12 }],
    failure: [{ frequency: 220, start: 0, duration: 0.28, gain: 0.12 }],
  },
  ding: {
    completion: [{ frequency: 880, start: 0, duration: 0.32, gain: 0.16 }],
    failure: [{ frequency: 332, start: 0, duration: 0.28, gain: 0.16, type: 'triangle' }],
  },
  bell: {
    completion: [{ frequency: 1046.5, start: 0, duration: 0.55, gain: 0.14 }, { frequency: 783.99, start: 0.06, duration: 0.75, gain: 0.1 }],
    failure: [{ frequency: 392, start: 0, duration: 0.45, gain: 0.14, type: 'triangle' }, { frequency: 311.13, start: 0.08, duration: 0.55, gain: 0.1, type: 'triangle' }],
  },
  pop: {
    completion: [{ frequency: 500, start: 0, duration: 0.09, gain: 0.16 }, { frequency: 900, start: 0.08, duration: 0.12, gain: 0.14 }],
    failure: [{ frequency: 300, start: 0, duration: 0.12, gain: 0.14 }, { frequency: 150, start: 0.1, duration: 0.18, gain: 0.12 }],
  },
  beep: {
    completion: [{ frequency: 440, start: 0, duration: 0.12, gain: 0.1, type: 'square' }],
    failure: [{ frequency: 220, start: 0, duration: 0.4, gain: 0.1, type: 'square' }],
  },
  success: {
    completion: [{ frequency: 523.25, start: 0, duration: 0.14 }, { frequency: 659.25, start: 0.14, duration: 0.14 }, { frequency: 783.99, start: 0.28, duration: 0.3 }],
    failure: [{ frequency: 261.63, start: 0, duration: 0.18 }, { frequency: 233.08, start: 0.18, duration: 0.18 }, { frequency: 174.61, start: 0.36, duration: 0.35, type: 'triangle' }],
  },
};

function play(pattern, style, volume = 1) {
  if (!style || style === 'none') return;
  const context = getContext();
  if (!context) return;
  const notes = PATTERNS[style]?.[pattern] || PATTERNS.chime[pattern];
  try {
    if (context.state === 'suspended') void context.resume();
    const safeVolume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
    for (const note of notes) tone(context, { ...note, volume: safeVolume });
  } catch {}
}

export function playCompletionSound(style = 'chime', volume = 1) {
  play('completion', style, volume);
}

export function playFailureSound(style = 'chime', volume = 1) {
  play('failure', style, volume);
}
