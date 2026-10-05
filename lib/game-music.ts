/**
 * 背景音乐：若 /public/sounds/bgm.mp3 存在则循环播放该文件，
 * 否则用 Web Audio 实时合成一段舒缓的五声音阶（古筝式拨弦）作为兜底。
 * 必须由用户操作触发 startMusic，浏览器不允许自动播放。
 */
const BGM_URL = "/sounds/bgm.mp3";
const FILE_VOLUME = 0.35;
const SYNTH_VOLUME = 0.5;

let musicVolume = 1;

// D 宫五声音阶（D E F# A B），跨两个八度。
const SCALE = [293.66, 329.63, 369.99, 440, 493.88, 587.33, 659.25, 739.99, 880, 987.77];

let audio: HTMLAudioElement | null = null;
let context: AudioContext | null = null;
let master: GainNode | null = null;
let timer: number | undefined;
let running = false;
let fileChecked: Promise<boolean> | null = null;

function hasFile() {
  fileChecked ??= fetch(BGM_URL, { method: "HEAD" })
    .then((response) => response.ok && (response.headers.get("content-type") ?? "").startsWith("audio"))
    .catch(() => false);
  return fileChecked;
}

function pluck(ctx: AudioContext, out: AudioNode, when: number, frequency: number, volume: number) {
  const oscillator = ctx.createOscillator();
  const overtone = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = "triangle";
  overtone.type = "sine";
  oscillator.frequency.value = frequency;
  overtone.frequency.value = frequency * 2;
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(volume, when + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + 2.2);
  const overtoneGain = ctx.createGain();
  overtoneGain.gain.value = 0.25;
  oscillator.connect(gain);
  overtone.connect(overtoneGain).connect(gain);
  gain.connect(out);
  oscillator.start(when);
  overtone.start(when);
  oscillator.stop(when + 2.3);
  overtone.stop(when + 2.3);
}

function startSynth() {
  context ??= new AudioContext();
  const ctx = context;
  void ctx.resume();
  if (!master) {
    master = ctx.createGain();
    master.gain.value = 0;
    // 简易回声营造空间感。
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.38;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.32;
    const wet = ctx.createGain();
    wet.gain.value = 0.45;
    master.connect(ctx.destination);
    master.connect(delay);
    delay.connect(feedback).connect(delay);
    delay.connect(wet).connect(ctx.destination);
  }
  master.gain.cancelScheduledValues(ctx.currentTime);
  master.gain.setTargetAtTime(SYNTH_VOLUME * musicVolume, ctx.currentTime, 0.6);

  let index = 4;
  const step = () => {
    if (!running || !context || !master) return;
    const now = context.currentTime + 0.05;
    // 在音阶上随机游走，偶尔跳进，形成不重复但统一的旋律线。
    index = Math.max(0, Math.min(SCALE.length - 1, index + Math.round((Math.random() - 0.5) * 4)));
    pluck(context, master, now, SCALE[index], 0.16);
    if (Math.random() < 0.28) pluck(context, master, now + 0.18, SCALE[Math.max(0, index - 2)], 0.1);
    if (Math.random() < 0.12) pluck(context, master, now, SCALE[0] / 2, 0.14);
    timer = window.setTimeout(step, 650 + Math.random() * 1100);
  };
  step();
}

export async function startMusic() {
  if (typeof window === "undefined" || running) return;
  running = true;
  if (await hasFile()) {
    if (!running) return;
    audio ??= new Audio(BGM_URL);
    audio.loop = true;
    audio.volume = FILE_VOLUME * musicVolume;
    try {
      await audio.play();
    } catch {
      // 被浏览器拦截时静默忽略，用户再点一次即可。
      running = false;
    }
    return;
  }
  if (running) startSynth();
}

/** 背景音乐音量，0–1；播放中也会实时生效。 */
export function setMusicVolume(volume: number) {
  musicVolume = Math.max(0, Math.min(1, volume));
  if (audio) audio.volume = FILE_VOLUME * musicVolume;
  if (running && context && master) master.gain.setTargetAtTime(SYNTH_VOLUME * musicVolume, context.currentTime, 0.05);
}

export function stopMusic() {
  running = false;
  window.clearTimeout(timer);
  audio?.pause();
  if (context && master) master.gain.setTargetAtTime(0, context.currentTime, 0.25);
}

export function disposeMusic() {
  stopMusic();
  audio = null;
  master = null;
  void context?.close();
  context = null;
}
