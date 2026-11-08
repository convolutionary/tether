import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeftRight,
  Braces,
  Columns2,
  CornerDownLeft,
  FolderTree,
  Import,
  Plus,
  Radio,
  Rows2,
  Server,
  Settings2,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import { blankSession, NIL, type Session } from "../lib/api";
import { fuzzy, mod } from "../lib/format";
import { get, set, useStore } from "../lib/store";
import { label, openSession, sendText, splitActive } from "../lib/terms";
import { runImport } from "./SessionsPanel";
import { newLocal } from "./TabBar";
import { Dot, Kbd } from "./ui";

interface Item {
  id: string;
  group: "Connect" | "Sessions" | "Actions" | "Snippets";
  title: string;
  detail?: string;
  icon?: LucideIcon;
  session?: Session;
  hint?: string;
  run: (alt: boolean) => void;
}

/** Parse "user@host:port", "rdp://…", "/dev/ttyUSB0@115200", "COM3" into a one-off session. */
export function quick(input: string): Session | null {
  const s = input.trim();
  if (!s || /\s/.test(s)) return null;
  const m = s.match(/^(ssh|sftp|telnet|mosh|rdp|vnc|serial):\/\/(.*)$/i);
  const protocol = (m ? m[1].toLowerCase() : /^(\/dev\/|COM\d)/i.test(s) ? "serial" : "ssh") as Session["protocol"];
  const rest = (m ? m[2] : s).replace(/\/$/, "");
  const base = { ...blankSession(protocol), id: NIL };
  if (protocol === "serial") {
    const [dev, baud] = rest.split("@");
    return { ...base, device: dev, baud: baud ? +baud || 115200 : 115200, name: dev };
  }
  const at = rest.lastIndexOf("@");
  const user = at >= 0 ? rest.slice(0, at) : "";
  let hostport = at >= 0 ? rest.slice(at + 1) : rest;
  let port = base.port;
  const v6 = hostport.match(/^\[(.+)\](?::(\d+))?$/);
  if (v6) {
    hostport = v6[1];
    if (v6[2]) port = +v6[2];
  } else if ((hostport.match(/:/g) ?? []).length === 1) {
    const [h, p] = hostport.split(":");
    hostport = h;
    if (/^\d+$/.test(p)) port = +p;
    else return null;
  }
  const v6ok = !!v6 || /^[0-9a-f:]+(%\w+)?$/i.test(hostport) && hostport.includes(":");
  if (!v6ok && !/^[A-Za-z0-9_][\w.-]*$/.test(hostport)) return null;
  return { ...base, user, host: hostport, port };
}

export function Palette() {
  const sessions = useStore((s) => s.sessions);
  const snippets = useStore((s) => s.snippets);
  const shells = useStore((s) => s.boot?.shells ?? []);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => set({ palette: false });

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const qs = quick(q);
    // an address goes first; a plain word only becomes "connect to …" when nothing else matches
    const looksLikeAddress = /[@.:]|^\w+:\/\/|^\/dev\/|^COM\d/i.test(q.trim());
    const quickItem: Item | null =
      qs && !sessions.some((s) => label(s) === q.trim())
        ? { id: "quick", group: "Connect", title: `Connect to ${q.trim()}`, detail: qs.protocol.toUpperCase(), icon: CornerDownLeft, run: (alt) => openSession(qs, alt ? "row" : undefined) }
        : null;
    if (quickItem && looksLikeAddress) out.push(quickItem);
    const scored = sessions
      .map((s) => ({ s, score: fuzzy(q, `${label(s)} ${s.host} ${s.user} ${s.folder} ${s.protocol}`) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => (q ? b.score - a.score : b.s.last_used - a.s.last_used))
      .slice(0, q ? 12 : 8);
    for (const { s } of scored) {
      out.push({
        id: s.id,
        group: "Sessions",
        title: label(s),
        detail: [s.folder, s.protocol === "serial" ? s.device : s.host].filter(Boolean).join(" · "),
        session: s,
        run: (alt) => openSession(s, alt ? "row" : undefined),
      });
    }
    const actions: Item[] = [
      { id: "a-local", group: "Actions", title: "New local terminal", icon: SquareTerminal, hint: `${mod}+Shift+T`, run: () => newLocal() },
      ...shells.slice(1).map((sh) => ({ id: `a-sh-${sh.name}`, group: "Actions" as const, title: `New ${sh.name} terminal`, icon: SquareTerminal, run: () => newLocal(sh.command, sh.name) })),
      { id: "a-new", group: "Actions", title: "New session…", icon: Plus, hint: `${mod}+Shift+N`, run: () => set({ editing: blankSession("ssh") }) },
      { id: "a-split-r", group: "Actions", title: "Split right", icon: Columns2, hint: `${mod}+Shift+D`, run: () => splitActive("row") },
      { id: "a-split-d", group: "Actions", title: "Split down", icon: Rows2, hint: `${mod}+Shift+E`, run: () => splitActive("column") },
      { id: "a-multi", group: "Actions", title: get().multiExec ? "Stop typing into every terminal" : "Type into every terminal", icon: Radio, run: () => set((s) => ({ multiExec: !s.multiExec })) },
      { id: "a-files", group: "Actions", title: "Show files", icon: FolderTree, hint: `${mod}+2`, run: () => set({ panel: "files" }) },
      { id: "a-tunnels", group: "Actions", title: "Show tunnels", icon: ArrowLeftRight, hint: `${mod}+3`, run: () => set({ panel: "tunnels" }) },
      { id: "a-import-ssh", group: "Actions", title: "Import ~/.ssh/config", icon: Import, run: () => runImport("ssh") },
      { id: "a-import-moba", group: "Actions", title: "Import from MobaXterm…", icon: Import, run: () => runImport("mobaxterm") },
      { id: "a-import-putty", group: "Actions", title: "Import from PuTTY", icon: Import, run: () => runImport("putty") },
      { id: "a-settings", group: "Actions", title: "Settings", icon: Settings2, hint: `${mod}+,`, run: () => set({ settingsOpen: true }) },
    ];
    for (const a of actions) if (fuzzy(q, a.title) >= 0) out.push(a);
    if (q) {
      for (const sn of snippets) {
        if (fuzzy(q, `${sn.name} ${sn.text}`) >= 0)
          out.push({ id: sn.id, group: "Snippets", title: sn.name || sn.text, detail: sn.name ? sn.text.split("\n")[0] : undefined, icon: Braces, run: (alt) => sendText(sn.text, sn.run, alt) });
      }
    }
    if (quickItem && !looksLikeAddress && out.length === 0) out.push(quickItem);
    return out;
  }, [q, sessions, snippets, shells]);

  useEffect(() => setHi(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(".pal-item.hi")?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  const choose = (it: Item | undefined, alt: boolean) => {
    if (!it) return;
    close();
    it.run(alt);
  };

  let lastGroup = "";
  return createPortal(
    <div className="scrim top" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-label="Connect or search">
        <div className="pal-input">
          <Server size={15} strokeWidth={1.75} />
          <input
            autoFocus
            value={q}
            placeholder="user@host, a saved session, or an action"
            spellCheck={false}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setHi((h) => Math.min(items.length - 1, h + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHi((h) => Math.max(0, h - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(items[hi], e.altKey || e.shiftKey);
              }
            }}
          />
        </div>
        <div className="pal-list" ref={listRef}>
          {items.length === 0 && <div className="pal-empty">No matches. Type <code>user@host</code> to connect anywhere.</div>}
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? <div className="pal-group" key={`g-${it.group}`}>{it.group}</div> : null;
            lastGroup = it.group;
            return (
              <div key={it.id}>
                {head}
                <button className={`pal-item ${i === hi ? "hi" : ""}`} onMouseMove={() => setHi(i)} onClick={(e) => choose(it, e.altKey || e.shiftKey)}>
                  <span className="pal-icon">{it.session ? <Dot protocol={it.session.protocol} color={it.session.color} /> : it.icon && <it.icon size={14} strokeWidth={1.75} />}</span>
                  <span className="pal-title">{it.title}</span>
                  {it.detail && <span className="pal-detail">{it.detail}</span>}
                  {it.hint && <span className="pal-hint">{it.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="pal-foot">
          <span><Kbd>↵</Kbd> open</span>
          <span><Kbd>Shift</Kbd><Kbd>↵</Kbd> in a split</span>
          <span><Kbd>Esc</Kbd> close</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
