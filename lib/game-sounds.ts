export type GameSoundKind = "move" | "capture" | "check" | "win" | "lose" | "draw";

let sharedContext: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  sharedContext ??= new AudioContext();
  if (sharedContext.state === "suspended") void sharedContext.resume();
  return sharedContext;
}

interface KnobOptions {
  volume?: number;
  duration?: number;
  centerFreq?: number;
  q?: number;
}

/** 木棋敲击：短促噪声经低通，带一点随机，避免连续走子完全一致。 */
function knock(context: AudioContext, when: number, options: KnobOptions = {}) {
  const {
    volume = 0.13,
    duration = 0.045,
    centerFreq = 520 + Math.random() * 60,
    q = 0.9,
  } = options;

  const sampleCount = Math.floor(context.sampleRate * duration);
  const buffer = context.createBuffer(1, sampleCount, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < sampleCount; index++) {
    const progress = index / sampleCount;
    const envelope = Math.pow(1 - progress, 2.8) * (1 - Math.exp(-progress * 120));
    data[index] = (Math.random() * 2 - 1) * envelope;
  }

  const source = context.createBufferSource();
  source.buffer = buffer;

  const filter = context.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(centerFreq, when);
  filter.frequency.exponentialRampToValueAtTime(Math.max(90, centerFreq * 0.42), when + duration);
  filter.Q.value = q;

  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(volume, when + 0.0025);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + duration + 0.014);

  source.connect(filter).connect(gain).connect(context.destination);
  source.start(when);
  source.stop(when + duration + 0.025);
}

function tone(
  context: AudioContext,
  when: number,
  frequency: number,
  duration: number,
  volume: number,
  type: OscillatorType = "sine",
) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, when);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(40, frequency * 0.93), when + duration);
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(volume, when + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(when);
  oscillator.stop(when + duration + 0.03);
}

/** 带轻微失谐的铃音，用于将军。 */
function bell(context: AudioContext, when: number, frequency: number, duration: number, volume: number) {
  tone(context, when, frequency, duration, volume * 0.7, "triangle");
  tone(context, when, frequency * 1.005, duration, volume * 0.3, "sine");
}

function chord(context: AudioContext, when: number, frequencies: number[], duration: number, volume: number) {
  const each = volume / frequencies.length;
  frequencies.forEach((frequency) => tone(context, when, frequency, duration, each, "sine"));
}

/**
 * 六种对局音效，音色与节奏刻意拉开：
 * - move     一记短亮木敲，无旋律
 * - capture  连续两声厚重木撞 + 低频余震
 * - check    三连铃音，无木声，突出“被将”
 * - draw     两段慢和弦，平稳绵长
 * - win      快速上行五声音阶 + 收尾轻敲
 * - lose     慢速下行低音，沉稳收束
 */
export function playGameSound(kind: GameSoundKind) {
  const context = getContext();
  if (!context) return;

  const now = context.currentTime;

  switch (kind) {
    case "move":
      knock(context, now, { volume: 0.14, duration: 0.036, centerFreq: 680 });
      break;

    case "capture":
      knock(context, now, { volume: 0.19, duration: 0.085, centerFreq: 270 });
      knock(context, now + 0.052, { volume: 0.13, duration: 0.06, centerFreq: 320 });
      tone(context, now + 0.018, 96, 0.15, 0.085, "triangle");
      break;

    case "check":
      bell(context, now, 784, 0.1, 0.11);
      bell(context, now + 0.11, 1046, 0.1, 0.105);
      bell(context, now + 0.23, 784, 0.12, 0.1);
      bell(context, now + 0.36, 1046, 0.14, 0.095);
      break;

    case "draw":
      chord(context, now, [261, 329, 392], 0.85, 0.13);
      chord(context, now + 0.5, [220, 277, 330], 0.9, 0.11);
      break;

    case "win":
      [523, 587, 659, 784, 1046].forEach((frequency, index) => {
        tone(context, now + index * 0.085, frequency, index === 4 ? 0.42 : 0.18, 0.09, "triangle");
      });
      knock(context, now + 0.44, { volume: 0.09, duration: 0.04, centerFreq: 600 });
      break;

    case "lose":
      [392, 311, 233, 196].forEach((frequency, index) => {
        tone(context, now + index * 0.22, frequency, index === 3 ? 0.6 : 0.38, 0.08, "sine");
      });
      break;
  }
}

export function disposeGameSounds() {
  void sharedContext?.close();
  sharedContext = null;
}
