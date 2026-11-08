// Changes to saved things: update the store, then persist.

import { api, newId, type Session, type Settings, type Snippet, type Tunnel } from "./api";
import { get, set, toast } from "./store";
import { retheme } from "./terms";

export function saveSessions(next: Session[]) {
  set({ sessions: next });
  api.saveSessions(next).catch((e) => toast(`Couldn't save sessions: ${e}`, "bad"));
}

export function upsertSession(s: Session) {
  const all = get().sessions;
  const i = all.findIndex((x) => x.id === s.id);
  saveSessions(i >= 0 ? all.map((x) => (x.id === s.id ? s : x)) : [...all, s]);
}

export function deleteSession(id: string) {
  const s = get().sessions.find((x) => x.id === id);
  saveSessions(get().sessions.filter((x) => x.id !== id).map((x) => (x.jump === id ? { ...x, jump: null } : x)));
  if (s) toast(`Deleted ${s.name || s.host}`, "info", { label: "Undo", run: () => upsertSession(s) }, 6000);
}

export function duplicateSession(s: Session) {
  upsertSession({ ...s, id: newId(), name: `${s.name || s.host} copy`, save_password: false, last_used: 0 });
}

export function mergeImported(found: Session[]): number {
  const have = get().sessions;
  const key = (s: Session) => `${s.protocol}|${s.host.toLowerCase()}|${s.port}|${s.user}|${s.device}`;
  const seen = new Set(have.map(key));
  const fresh = found.filter((s) => !seen.has(key(s)));
  // keep jump links that point at sessions we didn't import (duplicates) pointing at the existing one
  const remap = new Map<string, string>();
  for (const s of found) {
    if (seen.has(key(s))) {
      const existing = have.find((h) => key(h) === key(s));
      if (existing) remap.set(s.id, existing.id);
    }
  }
  const fixed = fresh.map((s) => (s.jump && remap.has(s.jump) ? { ...s, jump: remap.get(s.jump)! } : s));
  saveSessions([...have, ...fixed]);
  return fixed.length;
}

export function saveSettings(patch: Partial<Settings>) {
  const next = { ...get().settings!, ...patch };
  set({ settings: next });
  api.saveSettings(next).catch(() => {});
  applyAppearance();
  retheme();
}

export function applyAppearance() {
  const s = get().settings;
  if (!s) return;
  const dark = s.appearance === "dark" || (s.appearance === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.style.setProperty("--accent", s.accent);
}

export function saveTunnels(next: Tunnel[]) {
  set({ tunnels: next });
  api.saveTunnels(next).catch(() => {});
}

export function saveSnippets(next: Snippet[]) {
  set({ snippets: next });
  api.saveSnippets(next).catch(() => {});
}
