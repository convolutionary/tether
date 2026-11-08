import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Radio, Search, Settings2, Square, X } from "lucide-react";
import { set, useStore } from "../lib/store";
import { mod } from "../lib/format";
import { IconButton, Kbd } from "./ui";

export function Titlebar() {
  const tiling = useStore((s) => s.boot?.tiling ?? false);
  const multi = useStore((s) => s.multiExec);
  const win = getCurrentWindow();
  return (
    <header className="titlebar" data-tauri-drag-region onDoubleClick={(e) => e.target === e.currentTarget && win.toggleMaximize()}>
      <div className="brand" data-tauri-drag-region>
        <Mark />
        <span data-tauri-drag-region>Tether</span>
      </div>
      <button className="omnibox" onClick={() => set({ palette: true })}>
        <Search size={13} strokeWidth={2} />
        <span>Connect or search</span>
        <span className="omnibox-keys">
          <Kbd>{mod}</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>
      <div className="titlebar-right">
        <IconButton
          icon={Radio}
          label={multi ? "Typing into every terminal (click to stop)" : "Type into every terminal at once"}
          active={multi}
          className={multi ? "multi-on" : ""}
          onClick={() => set((s) => ({ multiExec: !s.multiExec }))}
        />
        <IconButton icon={Settings2} label="Settings" onClick={() => set({ settingsOpen: true })} />
        {!tiling && (
          <div className="winctl">
            <button aria-label="Minimize" onClick={() => win.minimize()}>
              <Minus size={14} strokeWidth={1.5} />
            </button>
            <button aria-label="Maximize" onClick={() => win.toggleMaximize()}>
              <Square size={11} strokeWidth={1.5} />
            </button>
            <button aria-label="Close" className="close" onClick={() => win.close()}>
              <X size={14} strokeWidth={1.5} />
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

/** The mark: two nodes on one line. */
export function Mark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="3.5" cy="12.5" r="2.25" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12.5" cy="3.5" r="2.25" fill="var(--accent)" />
      <path d="M5.2 10.8 10.8 5.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="1.6 1.9" />
    </svg>
  );
}
