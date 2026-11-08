import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "@xterm/xterm/css/xterm.css";
import "./styles/tokens.css";
import "./styles/app.css";
import { App } from "./App";

// no browser context menu or reload shortcuts in the app
window.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest("input, textarea, .selectable")) e.preventDefault();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "F5" && !(e.target as HTMLElement).closest(".flist")) e.preventDefault();
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r" && !e.shiftKey) {
    // Ctrl+R belongs to the shell (reverse search), never to the webview
    if (!(e.target as HTMLElement).closest(".xterm")) e.preventDefault();
  }
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
