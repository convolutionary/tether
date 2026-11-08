import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, ExternalLink, KeyRound, Monitor, Pencil, RotateCw, Search, X } from "lucide-react";
import RFB from "@novnc/novnc";
import { api } from "../lib/api";
import { get, leaves, patchPane, set, setRatio, useStore, type Layout, type Pane } from "../lib/store";
import { closePane, ensureXterm, focusPane, label, reconnect, TERMINAL_KINDS, xt } from "../lib/terms";
import { Browser } from "./FilesPanel";
import { PromptCard } from "./PromptCard";
import { Button, Spinner } from "./ui";
import { Welcome } from "./Welcome";

export function Workspace() {
  const tabs = useStore((s) => s.tabs);
  const active = useStore((s) => s.activeTab);
  if (!tabs.length) return <Welcome />;
  return (
    <div className="workspace">
      {tabs.map((t) => (
        <div key={t.key} className="tabpage" hidden={t.key !== active}>
          <LayoutView layout={t.layout} path="" tabKey={t.key} multi={leaves(t.layout).length > 1} />
        </div>
      ))}
    </div>
  );
}

function LayoutView({ layout, path, tabKey, multi }: { layout: Layout; path: string; tabKey: string; multi: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  if (layout.type === "leaf") return <PaneView paneKey={layout.pane} multi={multi} />;
  const row = layout.dir === "row";
  const drag = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    const move = (m: PointerEvent) => {
      const ratio = row ? (m.clientX - r.left) / r.width : (m.clientY - r.top) / r.height;
      const clamped = Math.min(0.85, Math.max(0.15, ratio));
      set((s) => ({ tabs: s.tabs.map((t) => (t.key === tabKey ? { ...t, layout: setRatio(t.layout, path, clamped) } : t)) }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div ref={ref} className={`split ${row ? "split-row" : "split-col"}`}>
      <div className="split-a" style={{ flexBasis: `${layout.ratio * 100}%` }}>
        <LayoutView layout={layout.a} path={path ? `${path}.a` : "a"} tabKey={tabKey} multi={multi} />
      </div>
      <div className={`gutter ${row ? "v" : "h"}`} onPointerDown={drag} />
      <div className="split-b">
        <LayoutView layout={layout.b} path={path ? `${path}.b` : "b"} tabKey={tabKey} multi={multi} />
      </div>
    </div>
  );
}

function PaneView({ paneKey, multi }: { paneKey: string; multi: boolean }) {
  const pane = useStore((s) => s.panes[paneKey]);
  const focused = useStore((s) => s.tabs.find((t) => t.key === s.activeTab)?.active === paneKey);
  const prompt = useStore((s) => (pane?.term != null ? s.prompts.find((p) => p.term === pane.term) : undefined));
  const multiExec = useStore((s) => s.multiExec);
  if (!pane) return null;
  const kind = pane.session.protocol;
  const neverReady = pane.status === "exited" && !pane.connected;
  return (
    <div
      className={`pane ${focused && multi ? "focused" : ""} ${multiExec && TERMINAL_KINDS.has(kind) ? "broadcast" : ""}`}
      onMouseDown={() => !focused && focusPane(paneKey)}
    >
      {TERMINAL_KINDS.has(kind) && <TerminalView pane={pane} />}
      {kind === "sftp" && pane.status === "ready" && pane.term != null && <div className="sftp-main"><Browser paneKey={paneKey} term={pane.term} wide /></div>}
      {kind === "vnc" && <VncView pane={pane} />}
      {kind === "rdp" && <ViewerView pane={pane} />}

      {pane.status === "connecting" && !prompt && (
        <div className="overlay">
          <div className="card connecting">
            <Spinner size={16} />
            <div className="card-text">
              <div className="card-title">{label(pane.session)}</div>
              <div className="card-sub">{pane.statusText || "Starting…"}</div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => closePane(paneKey)}>Cancel</Button>
          </div>
        </div>
      )}
      {prompt && (
        <div className="overlay">
          <PromptCard prompt={prompt} />
        </div>
      )}
      {pane.status === "exited" && neverReady && pane.exit?.reason && (
        <div className="overlay">
          <div className="card failed">
            <AlertTriangle size={18} className="card-icon bad" />
            <div className="card-text">
              <div className="card-title">Couldn't connect to {label(pane.session)}</div>
              <div className="card-sub selectable">{pane.exit.reason}</div>
              <div className="card-actions">
                <Button size="sm" variant="primary" onClick={() => reconnect(paneKey)}><RotateCw size={13} /> Try again</Button>
                {pane.session.id !== "00000000-0000-0000-0000-000000000000" && get().sessions.some((s) => s.id === pane.session.id) && (
                  <Button size="sm" onClick={() => set({ editing: get().sessions.find((s) => s.id === pane.session.id)! })}><Pencil size={13} /> Edit session</Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => closePane(paneKey)}>Close</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TerminalView({ pane }: { pane: Pane }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    const x = ensureXterm(pane.key);
    el.appendChild(x.host);
    const fit = () => {
      if (!el.offsetParent) return; // hidden tab
      try {
        x.fit.fit();
      } catch {
        /* not laid out yet */
      }
    };
    const ro = new ResizeObserver(() => requestAnimationFrame(fit));
    ro.observe(el);
    requestAnimationFrame(fit);
    return () => {
      ro.disconnect();
      if (x.host.parentElement === el) el.removeChild(x.host);
    };
  }, [pane.key]);
  const ended = pane.status === "exited" && pane.connected;
  const searching = useStore((s) => s.searching === pane.key);
  return (
    <div className="term-wrap">
      <div className="term" ref={ref} />
      {searching && <FindBar paneKey={pane.key} />}
      {ended && (
        <div className="ended">
          <span>Session ended{pane.exit?.reason ? ` · ${pane.exit.reason}` : pane.exit?.code != null ? ` · exit ${pane.exit.code}` : ""}</span>
          <Button size="sm" variant="primary" onClick={() => reconnect(pane.key)}><RotateCw size={12} /> Reconnect <kbd className="kbd inv">R</kbd></Button>
          <Button size="sm" variant="ghost" onClick={() => closePane(pane.key)}>Close</Button>
        </div>
      )}
    </div>
  );
}

function FindBar({ paneKey }: { paneKey: string }) {
  const [q, setQ] = useState("");
  const [cs, setCs] = useState(false);
  const [re, setRe] = useState(false);
  const [count, setCount] = useState<{ i: number; n: number } | null>(null);
  const x = xt(paneKey);
  useEffect(() => {
    if (!x) return;
    const d = x.search.onDidChangeResults((r) => setCount(r ? { i: r.resultIndex + 1, n: r.resultCount } : null));
    return () => {
      d.dispose();
      x.search.clearDecorations();
    };
  }, [x]);
  if (!x) return null;
  const opts = {
    caseSensitive: cs,
    regex: re,
    decorations: { matchOverviewRuler: "#888", activeMatchColorOverviewRuler: "#fff", matchBackground: "#5a4a1a", activeMatchBackground: "#b8862c" },
  };
  const find = (back = false) => (back ? x.search.findPrevious(q, opts) : x.search.findNext(q, opts));
  const close = () => {
    set({ searching: null });
    x.term.focus();
  };
  return (
    <div className="findbar" role="search">
      <Search size={13} />
      <input
        autoFocus
        value={q}
        placeholder="Find"
        spellCheck={false}
        onChange={(e) => {
          setQ(e.target.value);
          if (e.target.value) x.search.findNext(e.target.value, { ...opts, incremental: true });
          else {
            x.search.clearDecorations();
            setCount(null);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") find(e.shiftKey);
          if (e.key === "Escape") close();
        }}
      />
      <span className="find-count">{q ? (count && count.n ? `${count.i}/${count.n}` : "0") : ""}</span>
      <button className={`find-opt ${cs ? "on" : ""}`} title="Match case" onClick={() => setCs(!cs)}>Aa</button>
      <button className={`find-opt ${re ? "on" : ""}`} title="Regular expression" onClick={() => setRe(!re)}>.*</button>
      <button className="ibtn tiny" aria-label="Previous" onClick={() => find(true)}><ChevronUp size={13} /></button>
      <button className="ibtn tiny" aria-label="Next" onClick={() => find(false)}><ChevronDown size={13} /></button>
      <button className="ibtn tiny" aria-label="Close" onClick={close}><X size={13} /></button>
    </div>
  );
}

function VncView({ pane }: { pane: Pane }) {
  const ref = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [needPassword, setNeedPassword] = useState(false);
  const [pw, setPw] = useState("");
  useEffect(() => {
    if (pane.term == null || rfbRef.current || pane.status === "exited") return;
    let cancelled = false;
    api
      .vncBridge(pane.term)
      .then((b) => {
        if (cancelled || !ref.current) return;
        const rfb = new RFB(ref.current, b.url, { credentials: b.password ? { password: b.password } : undefined, wsProtocols: ["binary"] });
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.background = "transparent";
        rfb.addEventListener("connect", () => patchPane(pane.key, { status: "ready", statusText: "", connected: true }));
        rfb.addEventListener("disconnect", (e: CustomEvent<{ clean: boolean }>) => {
          patchPane(pane.key, { status: "exited", exit: { code: null, reason: e.detail.clean ? "disconnected" : "the connection dropped" } });
          rfbRef.current = null;
        });
        rfb.addEventListener("credentialsrequired", () => setNeedPassword(true));
        rfb.addEventListener("securityfailure", (e: CustomEvent<{ reason?: string }>) =>
          patchPane(pane.key, { status: "exited", exit: { code: null, reason: e.detail.reason || "wrong password" } }),
        );
        rfbRef.current = rfb;
      })
      .catch((e) => patchPane(pane.key, { status: "exited", exit: { code: null, reason: String(e) } }));
    return () => {
      cancelled = true;
    };
  }, [pane.term, pane.status, pane.key, pane.session.host]);
  useEffect(() => () => rfbRef.current?.disconnect(), []);
  return (
    <div className="vnc">
      <div className="vnc-screen" ref={ref} />
      {needPassword && (
        <div className="overlay">
          <form
            className="card prompt"
            onSubmit={(e) => {
              e.preventDefault();
              rfbRef.current?.sendCredentials({ password: pw });
              setNeedPassword(false);
            }}
          >
            <KeyRound size={18} className="card-icon" />
            <div className="card-text">
              <div className="card-title">VNC password for {pane.session.host}</div>
              <input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
              <div className="card-actions">
                <Button size="sm" variant="primary" type="submit">Connect</Button>
                <Button size="sm" variant="ghost" type="button" onClick={() => closePane(pane.key)}>Cancel</Button>
              </div>
            </div>
          </form>
        </div>
      )}
      {pane.status === "exited" && pane.connected && (
        <div className="ended">
          <span>{pane.exit?.reason}</span>
          <Button size="sm" variant="primary" onClick={() => { rfbRef.current = null; reconnect(pane.key); }}><RotateCw size={12} /> Reconnect</Button>
        </div>
      )}
    </div>
  );
}

function ViewerView({ pane }: { pane: Pane }) {
  if (pane.status === "connecting") return <div className="viewer" />;
  return (
    <div className="viewer">
      <div className="viewer-card">
        <Monitor size={28} strokeWidth={1.4} />
        <div className="viewer-title">{label(pane.session)}</div>
        {pane.status === "ready" ? (
          <>
            <p className="muted">The remote desktop is open in its own window.</p>
            <div className="card-actions center">
              <Button size="sm" onClick={() => closePane(pane.key)}><X size={13} /> Disconnect</Button>
            </div>
          </>
        ) : (
          <>
            <p className="muted">{pane.exit?.reason === "window closed" ? "The remote desktop window was closed." : pane.exit?.reason}</p>
            <div className="card-actions center">
              <Button size="sm" variant="primary" onClick={() => reconnect(pane.key)}><ExternalLink size={13} /> Open again</Button>
              <Button size="sm" variant="ghost" onClick={() => closePane(pane.key)}>Close tab</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
