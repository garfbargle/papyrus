import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// Mobile browsers report `100vh` as the *large* viewport (URL bar hidden), so a
// full-height layout is taller than what's actually on screen while the toolbar
// shows — clipping the top nav and page bottom with no way to scroll to them.
// Publish the genuinely-visible height as `--app-height` and let the stylesheet
// size everything from it. `dvh` is the CSS fallback until this first runs.
function trackViewportHeight() {
  const root = document.documentElement;
  const apply = () => root.style.setProperty("--app-height", `${window.innerHeight}px`);
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
