import { Download, Plus, SquareTerminal } from "lucide-react";
import { blankSession } from "../lib/api";
import { ago, mod } from "../lib/format";
import { set, useStore } from "../lib/store";
import { label, openSession } from "../lib/terms";
import { runImport } from "./SessionsPanel";
import { newLocal } from "./TabBar";
import { Mark } from "./Titlebar";
import { Dot, Kbd } from "./ui";

export function Welcome() {
  const sessions = useStore((s) => s.sessions);
  const hasSshConfig = useStore((s) => s.boot?.hasSshConfig ?? false);
  const recent = [...sessions].filter((s) => s.last_used > 0).sort((a, b) => b.last_used - a.last_used).slice(0, 6);
  const shown = recent.length ? recent : sessions.slice(0, 6);
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-mark"><Mark size={28} /></div>
        <h1>Where to?</h1>
        {shown.length > 0 && (
          <div className="welcome-list">
            <div className="welcome-h">{recent.length ? "Recent" : "Saved"}</div>
            {shown.map((s) => (
              <button key={s.id} className="welcome-row" onClick={() => openSession(s)}>
                <Dot protocol={s.protocol} color={s.color} />
                <span className="wr-name">{label(s)}</span>
                <span className="wr-target mono">{s.protocol === "serial" ? s.device : s.host}</span>
                <span className="wr-when">{recent.length ? ago(s.last_used) : s.protocol.toUpperCase()}</span>
              </button>
            ))}
          </div>
        )}
        <div className="welcome-actions">
          <button className="welcome-act" onClick={() => set({ palette: true })}>
            <span>Connect to a host</span>
            <span className="keys"><Kbd>{mod}</Kbd><Kbd>K</Kbd></span>
          </button>
          <button className="welcome-act" onClick={() => newLocal()}>
            <span><SquareTerminal size={13} /> Local terminal</span>
            <span className="keys"><Kbd>{mod}</Kbd><Kbd>Shift</Kbd><Kbd>T</Kbd></span>
          </button>
          <button className="welcome-act" onClick={() => set({ editing: blankSession("ssh") })}>
            <span><Plus size={13} /> New session</span>
            <span className="keys"><Kbd>{mod}</Kbd><Kbd>Shift</Kbd><Kbd>N</Kbd></span>
          </button>
        </div>
        {sessions.length === 0 && (
          <div className="welcome-import">
            <Download size={13} />
            Coming from somewhere else?
            {hasSshConfig && <button className="link" onClick={() => runImport("ssh")}>~/.ssh/config</button>}
            <button className="link" onClick={() => runImport("mobaxterm")}>MobaXterm</button>
            <button className="link" onClick={() => runImport("putty")}>PuTTY</button>
          </div>
        )}
      </div>
    </div>
  );
}
