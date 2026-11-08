import { ArrowLeftRight, Braces, FolderTree, Server } from "lucide-react";
import { set, useStore, type PanelId } from "../lib/store";
import { mod } from "../lib/format";

const ITEMS: { id: PanelId; icon: typeof Server; label: string; key: string }[] = [
  { id: "sessions", icon: Server, label: "Sessions", key: "1" },
  { id: "files", icon: FolderTree, label: "Files", key: "2" },
  { id: "tunnels", icon: ArrowLeftRight, label: "Tunnels", key: "3" },
  { id: "snippets", icon: Braces, label: "Snippets", key: "4" },
];

export function Rail() {
  const panel = useStore((s) => s.panel);
  const tunnelsUp = useStore((s) => Object.values(s.tunnelStates).filter((t) => t.state === "running").length);
  const transfers = useStore((s) => Object.values(s.transfers).filter((t) => t.state === "running").length);
  return (
    <nav className="rail" aria-label="Panels">
      {ITEMS.map((it) => (
        <button
          key={it.id}
          className={`rail-btn ${panel === it.id ? "on" : ""}`}
          title={`${it.label}  ${mod}+${it.key}`}
          aria-label={it.label}
          aria-pressed={panel === it.id}
          onClick={() => set((s) => ({ panel: s.panel === it.id ? null : it.id }))}
        >
          <it.icon size={18} strokeWidth={1.6} />
          {it.id === "tunnels" && tunnelsUp > 0 && <span className="rail-badge">{tunnelsUp}</span>}
          {it.id === "files" && transfers > 0 && <span className="rail-badge busy">{transfers}</span>}
        </button>
      ))}
    </nav>
  );
}
