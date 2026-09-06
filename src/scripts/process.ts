/**
 * Process page: stage tabs (all panels are server-rendered; this only
 * toggles `hidden`) and the walkthrough replay that reveals one row at a
 * time and follows the ticket through the stage tabs.
 */
const $$ = <T extends Element>(sel: string, root: ParentNode = document) => Array.from(root.querySelectorAll<T>(sel));
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ── stage tabs ────────────────────────────────────────────────────── */
const tabs = $$<HTMLButtonElement>('[data-stage-tab]');
const panels = $$<HTMLElement>('[data-stage-panel]');

function selectStage(i: number, focus = false) {
  tabs.forEach((t, j) => {
    const on = j === i;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    if (on && focus) t.focus();
  });
  panels.forEach((p, j) => { p.hidden = j !== i; });
}

tabs.forEach((t, i) => {
  t.addEventListener('click', () => selectStage(i));
  t.addEventListener('keydown', (e) => {
    const n = tabs.length;
    if (e.key === 'ArrowRight') { e.preventDefault(); selectStage((i + 1) % n, true); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); selectStage((i - 1 + n) % n, true); }
    if (e.key === 'Home') { e.preventDefault(); selectStage(0, true); }
    if (e.key === 'End') { e.preventDefault(); selectStage(n - 1, true); }
  });
});

/* ── walkthrough replay ────────────────────────────────────────────── */
const replay = document.querySelector<HTMLButtonElement>('[data-replay]');
const rows = $$<HTMLElement>('[data-walk] > li');
let timer: number | undefined;
let step = rows.length;

function paint(playing: boolean) {
  rows.forEach((r, i) => {
    r.classList.toggle('is-dim', i >= step);
    r.classList.toggle('is-current', playing && i === step - 1);
  });
}

function stop() {
  if (timer) clearInterval(timer);
  timer = undefined;
  replay?.setAttribute('aria-pressed', 'false');
  if (replay) replay.textContent = 'replay the ticket';
  paint(false);
}

function play() {
  step = 0;
  paint(true);
  replay?.setAttribute('aria-pressed', 'true');
  if (replay) replay.textContent = 'pause';
  const interval = reduceMotion ? 1000 : 620;
  timer = window.setInterval(() => {
    if (step >= rows.length) { stop(); return; }
    const stage = Number(rows[step].dataset.walkStage);
    step += 1;
    if (!Number.isNaN(stage)) selectStage(stage);
    paint(true);
  }, interval);
}

replay?.addEventListener('click', () => (timer ? stop() : play()));
document.addEventListener('visibilitychange', () => { if (document.hidden && timer) stop(); });

export {};
