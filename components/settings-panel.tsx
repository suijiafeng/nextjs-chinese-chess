"use client";

import { useEffect, useRef, useState } from "react";

export interface AudioSettings {
  soundOn: boolean;
  soundVolume: number;
  musicOn: boolean;
  musicVolume: number;
}

interface SettingsPanelProps {
  settings: AudioSettings;
  onChange: (patch: Partial<AudioSettings>) => void;
  /** 松开音效滑块时试听一次。 */
  onPreviewSound: () => void;
}

function Row({
  label,
  hint,
  on,
  volume,
  onToggle,
  onVolume,
  onCommit,
}: {
  label: string;
  hint?: string;
  on: boolean;
  volume: number;
  onToggle: (on: boolean) => void;
  onVolume: (volume: number) => void;
  onCommit?: () => void;
}) {
  return (
    <div className={`setting-row${on ? "" : " is-off"}`}>
      <div className="setting-head">
        <span>
          {label}
          {hint ? <small>{hint}</small> : null}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={label}
          className="switch"
          onClick={() => onToggle(!on)}
        />
      </div>
      <input
        className="volume-slider"
        type="range"
        min={0}
        max={100}
        step={5}
        value={Math.round(volume * 100)}
        disabled={!on}
        aria-label={`${label}音量`}
        style={{ "--fill": `${Math.round(volume * 100)}%` } as React.CSSProperties}
        onChange={(event) => onVolume(Number(event.target.value) / 100)}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
      />
    </div>
  );
}

export function SettingsPanel({ settings, onChange, onPreviewSound }: SettingsPanelProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof PointerEvent && rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const anyOn = settings.soundOn || settings.musicOn;

  return (
    <div className="settings" ref={rootRef}>
      <button
        className={`icon-button${anyOn ? "" : " sound-off"}`}
        type="button"
        aria-label="声音设置"
        title="声音设置"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
      >
        {anyOn ? "♪" : "♩"}
      </button>
      {open ? (
        <div className="settings-popover" role="dialog" aria-label="声音设置">
          <div className="settings-title">声音</div>
          <Row
            label="音效"
            hint="落子、将军、胜负"
            on={settings.soundOn}
            volume={settings.soundVolume}
            onToggle={(soundOn) => onChange({ soundOn })}
            onVolume={(soundVolume) => onChange({ soundVolume })}
            onCommit={onPreviewSound}
          />
          <Row
            label="背景音乐"
            hint="需手动开启"
            on={settings.musicOn}
            volume={settings.musicVolume}
            onToggle={(musicOn) => onChange({ musicOn })}
            onVolume={(musicVolume) => onChange({ musicVolume })}
          />
        </div>
      ) : null}
    </div>
  );
}
