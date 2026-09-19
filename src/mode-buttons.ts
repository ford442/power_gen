/**
 * Simulation-mode button row — generated from `physics/devices.json` chrome
 * (emoji/label/sort), not hand-listed per device (docs/MODE_MATRIX.md).
 */
import { MODE_BUTTON_CHROME } from '../generated/device-catalog';

const MODE_BUTTON_ROW_ID = 'mode-button-row';
const DEFAULT_ACTIVE_MODE = 'seg';

/** Builds the `#mode-button-row` buttons from the catalog. Idempotent. */
export function renderModeButtons(activeMode: string = DEFAULT_ACTIVE_MODE): void {
  const row = document.getElementById(MODE_BUTTON_ROW_ID);
  if (!row) return;

  row.replaceChildren(
    ...MODE_BUTTON_CHROME.map((chrome) => {
      const btn = document.createElement('button');
      btn.className = 'mode-btn';
      btn.id = `btn-${chrome.id}`;
      btn.type = 'button';
      btn.classList.toggle('active', chrome.id === activeMode);
      btn.textContent = `${chrome.emoji} ${chrome.label}`;
      btn.addEventListener('click', () => window.setMode?.(chrome.id));
      return btn;
    })
  );
}
