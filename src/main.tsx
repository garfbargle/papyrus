import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./system-theme.css";
import "./system-shell.css";
import "./native-shell";

// Mobile browsers report `100vh` as the *large* viewport (URL bar hidden), so a
// full-height layout is taller than what's actually on screen while the toolbar
// shows — clipping the top nav and page bottom with no way to scroll to them.
// Publish the genuinely-visible height as `--app-height` and let the stylesheet
// size everything from it. `dvh` is the CSS fallback until this first runs.
function trackViewportHeight() {
  const root = document.documentElement;
  const stickyPreference = new URLSearchParams(window.location.search).get("sticky");
  const apply = () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    root.style.setProperty("--app-height", `${height}px`);

    // An embedded note often lives in a small square-ish panel, where the normal
    // two-pane notebook is needlessly dense. Keep tall, phone-sized views in the
    // regular mobile layout, but give genuinely tiny panels a focused sticky-note
    // treatment. Hosts can explicitly opt in or out with ?sticky=1 / ?sticky=0.
    const tinyPanel = width <= 480 && (height <= 540 || (width <= 360 && height <= 720));
    const compact = stickyPreference === "1" || (stickyPreference !== "0" && tinyPanel);
    root.dataset.compact = String(compact);
  };
  apply();
  window.addEventListener("resize", apply);
  window.addEventListener("orientationchange", apply);
  window.visualViewport?.addEventListener("resize", apply);
}

trackViewportHeight();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
