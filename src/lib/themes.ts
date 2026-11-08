import type { ITheme } from "@xterm/xterm";
import type { TerminalTheme } from "./api";

export interface Scheme {
  id: string;
  name: string;
  light: boolean;
  theme: ITheme;
}

const ansi = (c: string[]) => ({
  black: c[0], red: c[1], green: c[2], yellow: c[3], blue: c[4], magenta: c[5], cyan: c[6], white: c[7],
  brightBlack: c[8], brightRed: c[9], brightGreen: c[10], brightYellow: c[11], brightBlue: c[12], brightMagenta: c[13], brightCyan: c[14], brightWhite: c[15],
});

export const SCHEMES: Scheme[] = [
  {
    id: "graphite",
    name: "Graphite",
    light: false,
    theme: {
      background: "#0b0c0e", foreground: "#d9dbdf", cursor: "#8b9cff", cursorAccent: "#0b0c0e",
      selectionBackground: "#2a2f45", selectionForeground: "#ffffff",
      ...ansi(["#1d1f23", "#ef7b7b", "#8fcf8a", "#e5c07b", "#8b9cff", "#c69cf0", "#6fc6c0", "#c8cbd1",
        "#4a4e56", "#ff9696", "#a9e3a4", "#f2d49b", "#aab6ff", "#dbb8ff", "#93dcd6", "#f1f2f4"]),
    },
  },
  {
    id: "ink",
    name: "Ink",
    light: false,
    theme: {
      background: "#000000", foreground: "#cfcfcf", cursor: "#f0f0f0", cursorAccent: "#000000",
      selectionBackground: "#303030",
      ...ansi(["#000000", "#d75f5f", "#87af5f", "#d7af5f", "#5f87d7", "#af5fd7", "#5fafaf", "#bcbcbc",
        "#5f5f5f", "#ff8787", "#afd787", "#ffd787", "#87afff", "#d787ff", "#87d7d7", "#ffffff"]),
    },
  },
  {
    id: "paper",
    name: "Paper",
    light: true,
    theme: {
      background: "#fbfbfa", foreground: "#26282c", cursor: "#4f5fd9", cursorAccent: "#fbfbfa",
      selectionBackground: "#d6dbf7", selectionForeground: "#111111",
      ...ansi(["#26282c", "#c43e3e", "#3a8a3f", "#a3741d", "#4f5fd9", "#8c45b8", "#23827c", "#c9cbcf",
        "#7a7e86", "#de5a5a", "#4ea654", "#be8b2d", "#6b79e8", "#a865d1", "#35a199", "#f4f4f2"]),
    },
  },
];

/** Colours from the desktop (phiOS/HyDE writes them on every theme switch). */
export function fromSystem(t: TerminalTheme): ITheme {
  const p = t.palette;
  const names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;
  const out: ITheme = {
    background: t.background ?? undefined,
    foreground: t.foreground ?? undefined,
    cursor: t.cursor ?? t.foreground ?? undefined,
    selectionBackground: t.selectionBackground ?? undefined,
    selectionForeground: t.selectionForeground ?? undefined,
  };
  names.forEach((n, i) => {
    if (p[i]) (out as Record<string, string>)[n] = p[i]!;
  });
  return out;
}

/** Light or dark, from a background colour. */
export function isLight(hex: string | undefined): boolean {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return false;
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 150;
}
