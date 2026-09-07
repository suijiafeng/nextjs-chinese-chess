export type GameSoundKind = "start"
  | "move"
  | "capture"
  | "check"
  | "win"
  | "lose"
  | "draw"
  | "select"
  | "illegal"
  | "undo"
  | "lowtime"
  | "tick"
  | "timeout";

/** 传给语音包的附加信息，音效本身不使用。 */
export interface GameSoundDetail {
  /** 触发该事件的一方；和棋等无归属事件为 null。 */
  side: "red" | "black" | null;
  actor?: "human" | "ai";
  /** 着法记录，如“炮二平五”，可用于逐句报棋。 */
  notation?: string;
  piece?: string;
}

/**
 * 人声扩展点：注册后，每次音效播放时都会收到同一事件，可叠加报棋、将军提示等人声。
 * 未注册时行为与原先完全一致。
 */
export interface VoicePack {
  play(kind: GameSoundKind, detail: GameSoundDetail): void;
  dispose?(): void;
}

let voicePack: VoicePack | null = null;

export function registerVoicePack(pack: VoicePack | null) {
  voicePack?.dispose?.();
  voicePack = pack;
}

/**
 * 基于音频文件的语音包：clips 将事件映射到 URL，例如 { check: "/voice/check.mp3" }。
 * 缺少对应片段的事件会被静默跳过。
 */
export function createClipVoicePack(clips: Partial<Record<GameSoundKind, string>>): VoicePack {
  return {
    play(kind) {
      const url = clips[kind];
      if (!url) return;
      void new Audio(url).play().catch(() => undefined);
    },
  };
}

let sharedContext: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!sharedContext || sharedContext.state === "closed") sharedContext = new AudioContext();
  return sharedContext;
}

/** 浏览器要求用户操作后才能发声；首次点击/按键时提前创建并唤醒音频上下文。 */
if (typeof window !== "undefined") {
  const unlock = () => {
    const context = getContext();
    if (!context) return;
    if (context.state !== "running") void context.resume().catch(() => undefined);
    preloadClips(context);
  };
  window.addEventListener("pointerdown", unlock, { capture: true, passive: true });
  window.addEventListener("keydown", unlock, { capture: true, passive: true });
}

/**
 * 音频文件：把 /public/sounds/<事件名>.mp3 放进去即可替换对应的合成音效，缺失的事件自动回退到合成音。
 * 事件名：start move capture check win lose draw select illegal undo lowtime tick timeout。
 */
const CLIP_DIR = "/sounds";
const clips = new Map<GameSoundKind, AudioBuffer | null>();
const clipLoads = new Map<GameSoundKind, Promise<void>>();

function loadClip(context: AudioContext, kind: GameSoundKind) {
  let pending = clipLoads.get(kind);
  if (!pending) {
    pending = fetch(`${CLIP_DIR}/${kind}.mp3`)
      .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error("missing"))))
      .then((data) => context.decodeAudioData(data))
      .then((buffer) => void clips.set(kind, buffer))
      .catch(() => void clips.set(kind, null));
    clipLoads.set(kind, pending);
  }
  return pending;
}

const ALL_KINDS: GameSoundKind[] = [
  "start", "move", "capture", "check", "win", "lose", "draw",
  "select", "illegal", "undo", "lowtime", "tick", "timeout",
];

function preloadClips(context: AudioContext) {
  ALL_KINDS.forEach((kind) => void loadClip(context, kind));
}

function playClip(context: AudioContext, kind: GameSoundKind) {
  const buffer = clips.get(kind);
  if (!buffer) return false;
  const source = context.createBufferSource();
  source.buffer = buffer;
  // 走子/吃子音轻微变速，避免连续落子听起来一模一样。
  if (kind === "move" || kind === "capture") source.playbackRate.value = 0.96 + Math.random() * 0.08;
  source.connect(masterOutput(context));
  source.start();
  return true;
}

const masters = new WeakMap<AudioContext, GainNode>();
let soundVolume = 1;

/** 所有音效共用的总输出：音量 → 压限器，压限器防止鼓点、锣声叠加时削波爆音。 */
function masterOutput(context: AudioContext) {
  let master = masters.get(context);
  if (!master) {
    master = context.createGain();
    master.gain.value = soundVolume;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -10;
    compressor.knee.value = 8;
    compressor.ratio.value = 12;
    compressor.attack.value = 0.002;
    compressor.release.value = 0.2;
    master.connect(compressor).connect(context.destination);
    masters.set(context, master);
  }
  return master;
}

/** 音效总音量，0–1。 */
export function setSoundVolume(volume: number) {
  soundVolume = Math.max(0, Math.min(1, volume));
  const master = sharedContext && masters.get(sharedContext);
  if (master && sharedContext) master.gain.setTargetAtTime(soundVolume, sharedContext.currentTime, 0.02);
}

interface KnobOptions {
  volume?: number;
  duration?: number;
  centerFreq?: number;
  q?: number;
}

/** 噪声型木敲的响度补偿：低通后的短噪声峰值很低，需整体放大才与音调类音效相称。 */
const KNOCK_GAIN = 4;

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
  gain.gain.exponentialRampToValueAtTime(volume * KNOCK_GAIN, when + 0.0025);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + duration + 0.014);

  source.connect(filter).connect(gain).connect(masterOutput(context));
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
  oscillator.connect(gain).connect(masterOutput(context));
  oscillator.start(when);
  oscillator.stop(when + duration + 0.03);
}

/** 带轻微失谐的铃音，用于将军。 */
function bell(context: AudioContext, when: number, frequency: number, duration: number, volume: number) {
  tone(context, when, frequency, duration, volume * 0.7, "triangle");
  tone(context, when, frequency * 1.005, duration, volume * 0.3, "sine");
}

/** 低频鼓点：正弦音高快速下滑，给落子增加分量感。 */
function thump(context: AudioContext, when: number, frequency: number, duration: number, volume: number) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, when);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(30, frequency * 0.4), when + duration);
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(volume, when + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
  oscillator.connect(gain).connect(masterOutput(context));
  oscillator.start(when);
  oscillator.stop(when + duration + 0.03);
}

/** 锣声：一组非整数倍泛音，衰减很长，用于将军与胜负。 */
function gong(context: AudioContext, when: number, base: number, duration: number, volume: number) {
  [1, 1.47, 2.09, 2.56, 3.37].forEach((ratio, index) => {
    tone(context, when, base * ratio, duration / (1 + index * 0.45), (volume / (1 + index * 0.7)), "sine");
  });
}

function chord(context: AudioContext, when: number, frequencies: number[], duration: number, volume: number) {
  const each = volume / frequencies.length;
  frequencies.forEach((frequency) => tone(context, when, frequency, duration, each, "sine"));
}

/**
 * 七种对局音效，音色与节奏刻意拉开：
 * - start    两记轻木敲 + 一声上扬的清音，如摆子落定
 * - move     一记短亮木敲，无旋律
 * - capture  连续两声厚重木撞 + 低频余震
 * - check    三连铃音，无木声，突出“被将”
 * - draw     两段慢和弦，平稳绵长
 * - win      快速上行五声音阶 + 收尾轻敲
 * - lose     慢速下行低音，沉稳收束
 */
export function playGameSound(kind: GameSoundKind, detail: GameSoundDetail = { side: null }) {
  try {
    voicePack?.play(kind, detail);
  } catch {
    // 语音包异常不影响基础音效。
  }
  const context = getContext();
  if (!context) return;

  // 上下文被挂起时 currentTime 不前进，必须等唤醒后再排程，否则声音会丢失或错位。
  const play = () => {
    // 文件尚未加载完（或不存在）时使用合成音，保证每次事件都有声音。
    if (!playClip(context, kind)) renderSound(context, kind);
  };
  if (!clipLoads.has(kind)) void loadClip(context, kind);
  if (context.state === "running") {
    play();
  } else {
    void context.resume().then(play).catch(() => undefined);
  }
}

function renderSound(context: AudioContext, kind: GameSoundKind) {
  const now = context.currentTime;

  switch (kind) {
    case "start":
      // 开局如擂鼓三响，末尾一声锣。
      [0, 0.16, 0.32].forEach((offset, index) => {
        knock(context, now + offset, { volume: 0.12 + index * 0.02, duration: 0.05, centerFreq: 600 });
        thump(context, now + offset, 150 - index * 10, 0.16, 0.22 + index * 0.04);
      });
      gong(context, now + 0.34, 330, 1.1, 0.07);
      break;

    case "move":
      // 重木落盘：清脆的敲击 + 沉实的低频。
      knock(context, now, { volume: 0.16, duration: 0.04, centerFreq: 900 });
      thump(context, now, 170, 0.13, 0.26);
      tone(context, now, 300, 0.05, 0.05, "triangle");
      break;

    case "capture":
      // 重击：两下叠撞 + 深沉鼓点 + 短锣余响。
      knock(context, now, { volume: 0.22, duration: 0.09, centerFreq: 520 });
      knock(context, now + 0.045, { volume: 0.17, duration: 0.07, centerFreq: 700 });
      thump(context, now, 120, 0.3, 0.42);
      thump(context, now + 0.05, 80, 0.34, 0.3);
      gong(context, now + 0.03, 240, 0.5, 0.035);
      break;

    case "check":
      // 战鼓催阵：双击鼓 + 锣声。
      thump(context, now, 140, 0.2, 0.36);
      thump(context, now + 0.15, 140, 0.22, 0.4);
      knock(context, now, { volume: 0.15, duration: 0.05, centerFreq: 800 });
      knock(context, now + 0.15, { volume: 0.17, duration: 0.05, centerFreq: 800 });
      gong(context, now + 0.15, 440, 0.9, 0.09);
      break;

    case "draw":
      chord(context, now, [261, 329, 392], 0.85, 0.13);
      chord(context, now + 0.5, [220, 277, 330], 0.9, 0.11);
      gong(context, now, 196, 1.4, 0.04);
      break;

    case "select":
      // 拈起棋子：极轻的一声脆响。
      knock(context, now, { volume: 0.07, duration: 0.025, centerFreq: 1500 });
      tone(context, now, 920, 0.05, 0.03, "triangle");
      break;

    case "illegal":
      // 行不通：两下短促低沉的闷响。
      tone(context, now, 150, 0.09, 0.06, "square");
      tone(context, now + 0.11, 130, 0.12, 0.06, "square");
      thump(context, now, 110, 0.12, 0.12);
      break;

    case "undo":
      // 收回棋子：轻敲后向上一挑，有「撤回」的方向感。
      knock(context, now, { volume: 0.1, duration: 0.04, centerFreq: 700 });
      tone(context, now + 0.07, 330, 0.09, 0.05, "triangle");
      tone(context, now + 0.14, 440, 0.12, 0.05, "triangle");
      break;

    case "lowtime":
      // 时间告急：两声清亮的铃。
      bell(context, now, 880, 0.16, 0.1);
      bell(context, now + 0.2, 880, 0.2, 0.1);
      break;

    case "tick":
      // 最后十秒的滴答。
      knock(context, now, { volume: 0.1, duration: 0.03, centerFreq: 1300 });
      tone(context, now, 1000, 0.05, 0.04, "triangle");
      break;

    case "timeout":
      // 超时：沉重的双鼓加长锣，宣告时间已尽。
      thump(context, now, 120, 0.3, 0.4);
      thump(context, now + 0.25, 90, 0.4, 0.42);
      gong(context, now + 0.25, 196, 1.6, 0.1);
      break;

    case "win":
      // 凯旋：连击鼓点冲向高潮，上行号角 + 大锣。
      [0, 0.12, 0.24].forEach((offset) => thump(context, now + offset, 130, 0.16, 0.34));
      [392, 523, 659, 784, 1046].forEach((frequency, index) => {
        tone(context, now + 0.3 + index * 0.09, frequency, index === 4 ? 0.6 : 0.2, 0.09, "sawtooth");
        tone(context, now + 0.3 + index * 0.09, frequency * 2, index === 4 ? 0.5 : 0.18, 0.025, "triangle");
      });
      thump(context, now + 0.74, 100, 0.5, 0.45);
      gong(context, now + 0.74, 262, 2.0, 0.11);
      break;

    case "lose":
      // 败北：缓慢沉重的鼓点 + 下行低音 + 低沉锣响。
      [0, 0.38, 0.76].forEach((offset, index) => thump(context, now + offset, 95 - index * 12, 0.34, 0.36 - index * 0.04));
      [330, 294, 247, 196].forEach((frequency, index) => {
        tone(context, now + index * 0.26, frequency, index === 3 ? 0.9 : 0.4, 0.08, "triangle");
      });
      gong(context, now + 0.76, 147, 1.8, 0.07);
      break;
  }
}

export function disposeGameSounds() {
  voicePack?.dispose?.();
  void sharedContext?.close();
  sharedContext = null;
}
