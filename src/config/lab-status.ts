/** One-line lab status: console plus the explainer status line (lazy chunks only). */
export function setLabStatus(text: string, tag = 'lab'): void {
  console.info(`[${tag}] ${text}`);
  const el = document.getElementById('explainerStatus');
  if (el) el.textContent = text;
}
