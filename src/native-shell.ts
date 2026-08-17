type PadNativeBridge = {
  shareText?: (title: string, text: string) => void;
  setSystemBarsLight?: (light: boolean) => void;
};

declare global {
  interface Window {
    PadNative?: PadNativeBridge;
  }
}

const darkThemes = new Set(["graphite", "dracula", "gruvbox"]);

function syncSystemBars() {
  const theme = document.documentElement.dataset.theme;
  window.PadNative?.setSystemBarsLight?.(!theme || !darkThemes.has(theme));
}

function installNativeShare() {
  const bridge = window.PadNative;
  if (!bridge?.shareText || navigator.share) return;

  // Android WebView does not expose the Web Share API to Tauri. Provide the
  // same browser-facing contract so the existing Share button opens the real
  // Android chooser instead of falling through to the clipboard path.
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: async (data: ShareData) => {
      if (data.files?.length) {
        throw new DOMException("File sharing is not supported by Pad yet.", "NotSupportedError");
      }
      bridge.shareText?.(data.title || "Pad note", data.text || "");
    },
  });
}

function installNativeShell() {
  installNativeShare();
  syncSystemBars();
}

const themeObserver = new MutationObserver(syncSystemBars);
themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

installNativeShell();
window.addEventListener("load", installNativeShell, { once: true });

export {};
