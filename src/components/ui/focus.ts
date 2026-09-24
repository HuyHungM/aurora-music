/**
 * Focus helpers for overlay teardown (Phase 23). Focusing an element that
 * the browser refuses (e.g. `display: none`) is a silent no-op, so trying
 * every match in document order and stopping at the first that takes focus
 * reliably reaches the visible trigger without any layout heuristics.
 * In jsdom (no layout) the first match takes focus, keeping tests
 * deterministic.
 */
export function focusFirstByLabel(label: string): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  const matches = document.querySelectorAll(`[aria-label="${label}"]`);
  for (const element of Array.from(matches)) {
    const target = element as HTMLElement;
    if (typeof target.focus !== "function") {
      continue;
    }
    target.focus();
    if (document.activeElement === target) {
      return true;
    }
  }
  return false;
}
