import { useEffect } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, Info, XCircle } from "lucide-react";
import { api, blankSession, onEngine, onOpenUrl } from "./lib/api";
import { applyAppearance } from "./lib/data";
import { activePane, get, leaves, set, useStore } from "./lib/store";
import { closePane, closeTab, focusActive, handleEngine, openSession, requestCloseTab, retheme, splitActive, xt } from "./lib/terms";
import { FilesPanel } from "./components/FilesPanel";
import { Palette, quick } from "./components/Palette";
import { PromptCard } from "./components/PromptCard";
import { Rail } from "./components/Rail";
import { SessionEditor } from "./components/SessionEditor";
import { SessionsPanel } from "./components/SessionsPanel";
import { SettingsModal } from "./components/SettingsModal";
import { SnippetsPanel } from "./components/SnippetsPanel";
import { StatusBar } from "./components/StatusBar";
import { newLocal, TabBar } from "./components/TabBar";
import { Titlebar } from "./components/Titlebar";
import { TunnelsPanel } from "./components/TunnelsPanel";
import { Button, Modal } from "./components/ui";
import { Workspace } from "./components/Workspace";

export function App() {
  const booted = useStore((s) => s.booted);
  const panel = useStore((s) => s.panel);
  const palette = useStore((s) => s.palette);
  const editing = useStore((s) => s.editing);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const width = useStore((s) => s.settings?.sidebar_width ?? 300);
  const globalPrompt = useStore((s) => s.prompts.find((p) => p.term == null || !Object.values(s.panes).some((x) => x.term === p.term)));
  const multi = useStore((s) => s.multiExec);
  const hasTabs = useStore((s) => s.tabs.length > 0);
  const confirm = useStore((s) => s.confirmClose);
  const setConfirm = (v: null) => set({ confirmClose: v });

  useEffect(() => {
    const un: (() => void)[] = [];
    (async () => {
      const boot = await api.bootstrap();
      set({ booted: true, boot, sessions: boot.sessions, tunnels: boot.tunnels, snippets: boot.snippets, settings: boot.settings, systemTheme: boot.systemTheme, panel: boot.settings.sidebar_open ? "sessions" : null });
      for (const id of boot.runningTunnels) set((s) => ({ tunnelStates: { ...s.tunnelStates, [id]: { state: "running", connections: 0 } } }));
      applyAppearance();
      retheme();
      un.push(await onEngine(handleEngine));
      un.push(await onOpenUrl((url) => {
        const s = quick(url);
        if (s) openSession(s);
      }));
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const onScheme = () => {
        applyAppearance();
        retheme();
      };
      mq.addEventListener("change", onScheme);
      un.push(() => mq.removeEventListener("change", onScheme));
    })();
    return () => un.forEach((f) => f());
  }, []);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = get();
      if (s.palette || s.editing || s.settingsOpen) return;
      const k = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      const run = (f: () => void) => {
        e.preventDefault();
        e.stopPropagation();
        f();
      };
      if (ctrl && !e.shiftKey && k === "k") return run(() => set({ palette: true }));
      if (ctrl && !e.shiftKey && k === ",") return run(() => set({ settingsOpen: true }));
      if (ctrl && !e.shiftKey && ["1", "2", "3", "4"].includes(k) && !e.altKey) {
        const id = (["sessions", "files", "tunnels", "snippets"] as const)[+k - 1];
        return run(() => set((st) => ({ panel: st.panel === id ? null : id })));
      }
      if (ctrl && e.shiftKey) {
        if (k === "t") return run(() => newLocal());
        if (k === "n") return run(() => set({ editing: blankSession("ssh") }));
        if (k === "w") return run(() => {
          const p = activePane();
          if (!p) return;
          const tab = s.tabs.find((t) => t.key === p.tab)!;
          if (leaves(tab.layout).length > 1) closePane(p.key);
          else requestCloseTab(tab.key);
        });
        if (k === "d") return run(() => splitActive("row"));
        if (k === "e") return run(() => splitActive("column"));
        if (k === "m") return run(() => set((st) => ({ multiExec: !st.multiExec })));
        if (k === "f") return run(() => {
          const p = activePane();
          if (p && xt(p.key)) set({ searching: p.key });
        });
        if (k === "b") return run(() => set((st) => ({ panel: st.panel ? null : "sessions" })));
      }
      if (ctrl && (k === "tab" || k === "pagedown" || k === "pageup")) {
        const back = k === "pageup" || (k === "tab" && e.shiftKey);
        return run(() => {
          if (!s.tabs.length) return;
          const i = s.tabs.findIndex((t) => t.key === s.activeTab);
          const n = s.tabs[(i + (back ? -1 : 1) + s.tabs.length) % s.tabs.length];
          set({ activeTab: n.key });
          focusActive();
        });
      }
      if (e.altKey && /^[1-9]$/.test(k)) {
        return run(() => {
          const t = s.tabs[+k - 1];
          if (t) {
            set({ activeTab: t.key });
            focusActive();
          }
        });
      }
      if (ctrl && (k === "=" || k === "+" || k === "-" || k === "0")) {
        const p = activePane();
        const x = p && xt(p.key);
        if (x) {
          return run(() => {
            const base = s.settings?.font_size ?? 13;
            const cur = x.term.options.fontSize ?? base;
            x.term.options.fontSize = k === "0" ? base : Math.max(7, Math.min(36, cur + (k === "-" ? -1 : 1)));
            x.fit.fit();
          });
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  if (!booted) return <div className="boot" />;

  const Panel = { sessions: SessionsPanel, files: FilesPanel, tunnels: TunnelsPanel, snippets: SnippetsPanel }[panel ?? "sessions"];

  return (
    <div className={`app ${multi ? "multi" : ""}`}>
      <Titlebar />
      <div className="body">
        <Rail />
        {panel && (
          <aside className="sidebar" style={{ width }}>
            <Panel />
            <SidebarResizer />
          </aside>
        )}
        <main className="main">
          {hasTabs && <TabBar />}
          <Workspace />
          {hasTabs && <StatusBar />}
        </main>
      </div>
      {palette && <Palette />}
      {editing && <SessionEditor initial={editing} key={editing.id} />}
      {settingsOpen && <SettingsModal />}
      {globalPrompt && createPortal(<div className="scrim"><PromptCard prompt={globalPrompt} /></div>, document.body)}
      {confirm && (
        <Modal title="Close this tab?" width={400} onClose={() => setConfirm(null)}
          footer={<>
            <Button onClick={() => setConfirm(null)}>Keep it</Button>
            <Button variant="danger" autoFocus onClick={() => { closeTab(confirm.tab); setConfirm(null); }}>Disconnect</Button>
          </>}>
          <p className="modal-text">You're connected to <b>{confirm.names}</b>. Anything running in the foreground there will end.</p>
        </Modal>
      )}
      <Toasts />
    </div>
  );
}

function SidebarResizer() {
  return (
    <div
      className="sidebar-resizer"
      onPointerDown={(e) => {
        e.preventDefault();
        const start = e.clientX;
        const w0 = get().settings?.sidebar_width ?? 300;
        let w = w0;
        const move = (m: PointerEvent) => {
          w = Math.min(560, Math.max(220, w0 + m.clientX - start));
          set((s) => ({ settings: { ...s.settings!, sidebar_width: w } }));
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          document.body.classList.remove("resizing");
          api.saveSettings({ ...get().settings!, sidebar_width: w }).catch(() => {});
        };
        document.body.classList.add("resizing");
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
    />
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return createPortal(
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          {t.tone === "ok" ? <CheckCircle2 size={14} /> : t.tone === "bad" ? <XCircle size={14} /> : <Info size={14} />}
          <span className="toast-text">{t.text}</span>
          {t.action && (
            <button className="toast-act" onClick={() => {
              t.action!.run();
              set((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) }));
            }}>
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}

