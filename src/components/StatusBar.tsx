import { useEffect, useRef, useState } from "react";
import { api, type Stats } from "../lib/api";
import { bytes, duration } from "../lib/format";
import { useStore } from "../lib/store";
import { label } from "../lib/terms";
import { Dot } from "./ui";

/** Under the terminal: where you are, and how the server is doing. */
export function StatusBar() {
  const pane = useStore((s) => {
    const t = s.tabs.find((x) => x.key === s.activeTab);
    return t ? s.panes[t.active] : undefined;
  });
  const enabled = useStore((s) => s.settings?.stats_bar ?? true);
  const multi = useStore((s) => s.multiExec);
  const broadcastCount = useStore((s) => Object.values(s.panes).filter((p) => p.status === "ready" && p.term != null && ["ssh", "local", "telnet", "serial", "mosh"].includes(p.session.protocol)).length);
  const [stats, setStats] = useState<Stats | null>(null);
  const prev = useRef<[number, number] | null>(null);

  const term = pane?.term ?? null;
  const live = pane?.status === "ready" && pane.session.protocol === "ssh" && pane.remote?.os === "Linux";
  useEffect(() => {
    setStats(null);
    prev.current = null;
    if (!live || term == null || !enabled) return;
    let stop = false;
    const tick = async () => {
      try {
        const [s, sample] = await api.stats(term, prev.current);
        prev.current = sample;
        if (!stop) setStats(s);
      } catch {
        /* server gone or not Linux */
      }
    };
    tick();
    const t = setInterval(() => document.visibilityState === "visible" && tick(), 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [term, live, enabled]);

  if (!pane) return <footer className="statusbar" />;
  const s = pane.session;
  const where =
    s.protocol === "local" ? "this computer" :
    s.protocol === "serial" ? `${s.device} · ${s.baud} baud` :
    `${pane.remote?.user || s.user ? `${pane.remote?.user || s.user}@` : ""}${s.host}${s.port && ![22, 23, 3389, 5900].includes(s.port) ? `:${s.port}` : ""}`;

  return (
    <footer className="statusbar">
      <span className="sb-item sb-where">
        <Dot protocol={s.protocol} color={s.color} state={pane.status} />
        <span className="mono">{where}</span>
        {pane.remote?.os && <span className="sb-dim">{pane.remote.os}</span>}
      </span>
      {multi && <span className="sb-item sb-multi">typing into {broadcastCount} terminals</span>}
      {stats && (
        <span className="sb-stats" title={`${label(s)}: refreshed every 3 s`}>
          <Meter label="cpu" value={stats.cpu ?? 0} text={stats.cpu == null ? "…" : `${Math.round(stats.cpu)}%`} />
          <Meter label="mem" value={(stats.memUsed / Math.max(1, stats.memTotal)) * 100} text={`${bytes(stats.memUsed)} / ${bytes(stats.memTotal)}`} />
          <Meter label="disk" value={(stats.diskUsed / Math.max(1, stats.diskTotal)) * 100} text={`${Math.round((stats.diskUsed / Math.max(1, stats.diskTotal)) * 100)}%`} />
          <span className="sb-item"><span className="sb-dim">load</span> {stats.load1.toFixed(2)}</span>
          <span className="sb-item"><span className="sb-dim">up</span> {duration(stats.uptime)}</span>
        </span>
      )}
      <span className="sb-right">
        {pane.cwd && s.protocol === "ssh" && <span className="sb-item mono sb-dim sb-cwd" title={pane.cwd}><bdi>{pane.cwd}</bdi></span>}
        {["ssh", "local", "telnet", "serial", "mosh"].includes(s.protocol) && <span className="sb-item mono sb-dim">{pane.size[0]}×{pane.size[1]}</span>}
      </span>
    </footer>
  );
}

function Meter({ label, value, text }: { label: string; value: number; text: string }) {
  const tone = value > 90 ? "bad" : value > 75 ? "warn" : "";
  return (
    <span className="sb-item meter">
      <span className="sb-dim">{label}</span>
      <span className={`meter-bar ${tone}`}><span style={{ width: `${Math.min(100, Math.max(2, value))}%` }} /></span>
      <span className="meter-text">{text}</span>
    </span>
  );
}
