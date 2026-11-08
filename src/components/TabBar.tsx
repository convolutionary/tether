import { useState } from "react";
import { Columns2, Copy, Plus, RotateCw, Rows2, SquareTerminal, X, XSquare } from "lucide-react";
import { blankSession } from "../lib/api";
import { mod } from "../lib/format";
import { get, leaves, set, useStore } from "../lib/store";
import { closeTab, duplicateTab, focusActive, label, openSession, reconnect, requestCloseTab, splitActive } from "../lib/terms";
import { Dot, protoIcon, useMenu, type MenuEntry } from "./ui";

export function newLocal(command = "", name = "") {
  openSession({ ...blankSession("local"), id: "00000000-0000-0000-0000-000000000000", command, name });
}

export function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const active = useStore((s) => s.activeTab);
  const panes = useStore((s) => s.panes);
  const shells = useStore((s) => s.boot?.shells ?? []);
  const { open: menu, node } = useMenu();
  const [drag, setDrag] = useState<string | null>(null);

  const newMenu = (e: React.MouseEvent) =>
    menu(e, [
      ...shells.map((sh) => ({ label: sh.name, icon: SquareTerminal, run: () => newLocal(sh.command, sh.name.replace(/ \(default\)$/, "")) })),
      ...(shells.length ? ["-" as const] : []),
      { label: "New session…", icon: Plus, hint: `${mod}+Shift+N`, run: () => set({ editing: blankSession("ssh") }) },
    ]);

  return (
    <div className="tabbar" role="tablist" onDoubleClick={(e) => e.target === e.currentTarget && newLocal()}>
      {tabs.map((t) => {
        const ids = leaves(t.layout);
        const main = panes[t.active] ?? panes[ids[0]];
        if (!main) return null;
        const Icon = protoIcon(main.session.protocol);
        const split = ids.length > 1;
        const items: MenuEntry[] = [
          { label: "Duplicate", icon: Copy, run: () => duplicateTab(main.key) },
          { label: "Split right", icon: Columns2, hint: `${mod}+Shift+D`, run: () => { set({ activeTab: t.key }); splitActive("row"); } },
          { label: "Split down", icon: Rows2, hint: `${mod}+Shift+E`, run: () => { set({ activeTab: t.key }); splitActive("column"); } },
          ...(main.status === "exited" ? [{ label: "Reconnect", icon: RotateCw, run: () => reconnect(main.key) }] : []),
          "-",
          { label: "Close", icon: X, hint: `${mod}+Shift+W`, run: () => requestCloseTab(t.key) },
          { label: "Close others", icon: XSquare, run: () => get().tabs.filter((x) => x.key !== t.key).forEach((x) => closeTab(x.key)) },
        ];
        return (
          <div
            key={t.key}
            role="tab"
            aria-selected={t.key === active}
            className={`tab ${t.key === active ? "on" : ""} ${drag === t.key ? "dragging" : ""}`}
            style={main.session.color ? { ["--tab-accent" as string]: main.session.color } : undefined}
            draggable
            onDragStart={() => setDrag(t.key)}
            onDragEnd={() => setDrag(null)}
            onDragOver={(e) => {
              e.preventDefault();
              if (!drag || drag === t.key) return;
              const all = get().tabs;
              const from = all.findIndex((x) => x.key === drag);
              const to = all.findIndex((x) => x.key === t.key);
              const next = [...all];
              const [m] = next.splice(from, 1);
              next.splice(to, 0, m);
              set({ tabs: next });
            }}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                requestCloseTab(t.key);
              }
            }}
            onClick={() => {
              set({ activeTab: t.key });
              focusActive();
            }}
            onContextMenu={(e) => menu(e, items)}
            title={`${label(main.session)}${main.remote?.os ? ` · ${main.remote.os}` : ""}`}
          >
            <Dot protocol={main.session.protocol} color={main.session.color} state={main.status} />
            <Icon size={13} strokeWidth={1.7} className="tab-icon" />
            <span className="tab-name">{label(main.session)}</span>
            {split && <span className="tab-split">{ids.length}</span>}
            <button
              className="tab-close"
              aria-label="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                requestCloseTab(t.key);
              }}
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        );
      })}
      <button className="tab-new" aria-label="New terminal" title={`New terminal (${mod}+Shift+T) · right-click for shells`} onClick={() => newLocal()} onContextMenu={newMenu}>
        <Plus size={14} strokeWidth={2} />
      </button>
      {node}
    </div>
  );
}
