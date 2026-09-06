/**
 * Client behaviour for the Team page. Every panel is already in the
 * server-rendered HTML; this only switches which one is visible and filters
 * the roster by stage. With JS off the page reads fine: Atlas is open.
 */

const $$ = <T extends Element>(sel: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll<T>(sel));

const entries = $$<HTMLLIElement>('[data-entry]');
const selectors = $$<HTMLButtonElement>('[data-select]');
const panels = $$<HTMLElement>('[data-panel]');
const stageChips = $$<HTMLButtonElement>('button[data-stage]');
const countEl = document.querySelector<HTMLElement>('[data-shown-count]');
const handoffNote = document.querySelector<HTMLElement>('[data-handoff-note]');

const total = entries.length;
let active = panels[0]?.dataset.panel ?? '';

/** Display name of an agent, taken from its rendered panel heading. */
function displayName(name: string): string {
  const panel = panels.find((p) => p.dataset.panel === name);
  return panel?.querySelector('.name')?.textContent?.trim() ?? '';
}

function activate(name: string): void {
  if (!name) return;
  active = name;
  for (const p of panels) p.hidden = p.dataset.panel !== name;
  for (const b of selectors) b.setAttribute('aria-pressed', String(b.dataset.select === name));
  if (handoffNote) handoffNote.textContent = `${displayName(name)} sits here`;
}

function shownEntries(): HTMLLIElement[] {
  return entries.filter((e) => !e.hidden);
}

function pickStage(next: string): void {
  for (const chip of stageChips) chip.setAttribute('aria-pressed', String(chip.dataset.stage === next));
  for (const e of entries) e.hidden = next !== 'all' && e.dataset.stage !== next;

  const shown = shownEntries();
  if (countEl) countEl.textContent = `${shown.length} of ${total} shown`;

  // If the open agent is no longer in the roster, open the first one that is.
  if (!shown.some((e) => e.dataset.name === active) && shown[0]?.dataset.name) {
    activate(shown[0].dataset.name);
  }
}

for (const b of selectors) {
  b.addEventListener('click', () => activate(b.dataset.select ?? ''));
}
for (const chip of stageChips) {
  chip.addEventListener('click', () => pickStage(chip.dataset.stage ?? 'all'));
}

// Deep link: /team#agent-volt opens that agent.
const fromHash = document.location.hash.replace(/^#agent-/, '');
if (fromHash && panels.some((p) => p.dataset.panel === fromHash)) activate(fromHash);

// This file is a module (its own scope), not a global script.
export {};
