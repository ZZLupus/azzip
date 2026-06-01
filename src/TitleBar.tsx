import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Frameless window-controls row. Doubles as the window drag region.
 * Left: app name. Right: minimize + close buttons.
 */
export default function TitleBar() {
  const appWindow = getCurrentWindow();
  return (
    <div className="titlebar" data-tauri-drag-region>
      <span className="titlebar-name">azzip</span>
      <div className="titlebar-controls">
        <button
          className="winctl"
          onClick={() => appWindow.minimize()}
          aria-label="Minimize"
        >
          ─
        </button>
        <button
          className="winctl winctl-close"
          onClick={() => appWindow.close()}
          aria-label="Close"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
