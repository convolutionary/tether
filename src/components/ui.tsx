// Small, consistent building blocks. Everything else is assembled from these.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  AppWindow,
  Cable,
  Check,
  FolderSync,
  Monitor,
  MonitorSmartphone,
  Network,
  SquareTerminal,
  Waves,
  X,
  type LucideIcon,
} from "lucide-react";
import type { Protocol } from "../lib/api";

export const PROTOCOLS: { id: Protocol; name: string; icon: LucideIcon; hint: string }[] = [
  { id: "ssh", name: "SSH", icon: SquareTerminal, hint: "Terminal and files" },
  { id: "sftp", name: "SFTP", icon: FolderSync, hint: "Files only" },
  { id: "mosh", name: "Mosh", icon: Waves, hint: "Roaming terminal" },
  { id: "telnet", name: "Telnet", icon: Network, hint: "Unencrypted terminal" },
  { id: "serial", name: "Serial", icon: Cable, hint: "COM / tty consoles" },
  { id: "rdp", name: "RDP", icon: Monitor, hint: "Windows desktop" },
  { id: "vnc", name: "VNC", icon: MonitorSmartphone, hint: "Remote screen" },
  { id: "local", name: "Local", icon: AppWindow, hint: "A shell on this machine" },
];

export function protoIcon(p: Protocol): LucideIcon {
  return PROTOCOLS.find((x) => x.id === p)?.icon ?? SquareTerminal;
}

export function Dot({ protocol, color, state }: { protocol: Protocol; color?: string; state?: "connecting" | "ready" | "exited" }) {
  return <span className={`dot dot-${state ?? "idle"}`} style={{ ["--dot" as string]: color || `var(--p-${protocol})` }} />;
}

export function Button({
  children,
  variant = "plain",
  size = "md",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "plain" | "primary" | "danger" | "ghost"; size?: "sm" | "md" }) {
  return (
    <button {...rest} className={`btn btn-${variant} btn-${size} ${rest.className ?? ""}`}>
      {children}
    </button>
  );
}

export function IconButton({
  icon: Icon,
  label,
  active,
  size = 15,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string; active?: boolean; size?: number }) {
  return (
    <button {...rest} aria-label={label} title={rest.title ?? label} className={`ibtn ${active ? "on" : ""} ${rest.className ?? ""}`}>
      <Icon size={size} strokeWidth={1.75} />
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`switch ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export function Field({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`field ${wide ? "wide" : ""}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="row">
      <div className="row-text">
        <div className="row-label">{label}</div>
        {hint && <div className="row-hint">{hint}</div>}
      </div>
      <div className="row-control">{children}</div>
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={value === o.id ? "on" : ""} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, width = 560, className }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number; className?: string }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [onClose]);
  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${className ?? ""}`} style={{ width }} role="dialog" aria-modal>
        <header className="modal-head">
          <h2>{title}</h2>
          <IconButton icon={X} label="Close" onClick={onClose} />
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  /** shows a check mark, for choices like "sort by" */
  checked?: boolean;
  run: () => void;
}
/** "-" draws a separator, { heading } a small label above a group of choices */
export type MenuEntry = MenuItem | "-" | { heading: string };
const isItem = (e: MenuEntry): e is MenuItem => typeof e === "object" && "run" in e;

/** A context menu at the pointer. Close by choosing, Escape, or clicking away. */
export function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [hi, setHi] = useState(-1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.min(x, window.innerWidth - r.width - 6), y: Math.min(y, window.innerHeight - r.height - 6) });
  }, [x, y]);
  const real = items.map((it, i) => ({ it, i })).filter((e) => isItem(e.it) && !e.it.disabled);
  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const idx = real.findIndex((r) => r.i === hi);
        const n = e.key === "ArrowDown" ? (idx + 1) % real.length : (idx - 1 + real.length) % real.length;
        setHi(real[n]?.i ?? -1);
      }
      if (e.key === "Enter" && hi >= 0) {
        e.preventDefault();
        const it = items[hi] as MenuItem;
        onClose();
        it.run();
      }
    };
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
    };
  });
  return createPortal(
    <div ref={ref} className="menu" style={{ left: pos.x, top: pos.y }} role="menu">
      {items.map((it, i) =>
        it === "-" ? (
          <div key={i} className="menu-sep" />
        ) : !isItem(it) ? (
          <div key={i} className="menu-heading">{it.heading}</div>
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={it.disabled}
            className={`menu-item ${it.danger ? "danger" : ""} ${hi === i ? "hi" : ""}`}
            onMouseEnter={() => setHi(i)}
            onClick={() => {
              onClose();
              it.run();
            }}
          >
            <span className="menu-icon">
              {it.checked ? <Check size={14} strokeWidth={2} /> : it.icon && <it.icon size={14} strokeWidth={1.75} />}
            </span>
            <span className="menu-label">{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

export function useMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null);
  const open = (e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuEntry[]) => {
    e.preventDefault?.();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };
  const node = menu ? <Menu {...menu} onClose={() => setMenu(null)} /> : null;
  return { open, node };
}

export function Empty({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Icon size={22} strokeWidth={1.5} />
      <div className="empty-title">{title}</div>
      {children && <div className="empty-text">{children}</div>}
    </div>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />;
}
