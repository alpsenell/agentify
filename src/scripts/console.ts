/**
 * Client behaviour for the Console (home) page. Everything it touches is
 * already in the server-rendered HTML — this only switches views, animates
 * the board, timeline, log and router, and tracks scroll progress.
 */
import {
  ACTION_COUNT,
  BACKLOG,
  COLOR,
  DEFAULT_LOG_STEP,
  DEFAULT_PLAYHEAD,
  LOG,
  ROUTES,
  TIMELINE_DAYS,
  cardAgent,
} from '../data/console';

const $ = <T extends Element>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
const $$ = <T extends Element>(sel: string, root: ParentNode = document) => Array.from(root.querySelectorAll<T>(sel));

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ── header clock, action counter and footer ticker ─────────────────── */
const clock = document.querySelector<HTMLTimeElement>('[data-clock]');
const actionCountEl = $<HTMLElement>('[data-action-count]');
const tickerEl = $<HTMLElement>('[data-ticker]');
let actionCount = ACTION_COUNT;
let clockLabel = '--:--';
/** Index of the next log line to reveal; also drives the footer ticker. */
let logStep = DEFAULT_LOG_STEP;

function paintTicker() {
  if (!tickerEl) return;
  const agent = LOG[Math.min(LOG.length - 1, logStep)][0];
  tickerEl.textContent = `last action · ${agent} · ${clockLabel}`;
}

function bumpActions(by = 1) {
  actionCount += by;
  if (actionCountEl) actionCountEl.textContent = actionCount.toLocaleString('en-US');
}

function tickClock() {
  const d = new Date();
  clockLabel = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (clock) {
    clock.textContent = clockLabel;
    clock.dateTime = d.toISOString();
  }
  paintTicker();
}
tickClock();
window.setInterval(tickClock, 1000);

/* ── scroll progress bar ────────────────────────────────────────────── */
const progress = $<HTMLElement>('[data-progress]');
if (progress) {
  const onScroll = () => {
    const h = document.documentElement;
    const p = h.scrollTop / Math.max(1, h.scrollHeight - h.clientHeight);
    progress.style.setProperty('--progress', `${(p * 100).toFixed(2)}%`);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  onScroll();
}

/* ── view tabs ──────────────────────────────────────────────────────── */
const tabs = $$<HTMLButtonElement>('[data-view]');
const panels = $$<HTMLElement>('[data-panel]');
let currentView = tabs.find((t) => t.getAttribute('aria-selected') === 'true')?.dataset.view ?? 'pipeline';

function selectView(view: string, focusTab = false) {
  currentView = view;
  tabs.forEach((t) => {
    const on = t.dataset.view === view;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    if (on && focusTab) t.focus();
  });
  panels.forEach((p) => { p.hidden = p.dataset.panel !== view; });
  if (view === 'timeline') paintTimeline();
}

tabs.forEach((t) => t.addEventListener('click', () => selectView(t.dataset.view || 'pipeline')));
tabs.forEach((t, i) =>
  t.addEventListener('keydown', (e) => {
    const map: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };
    if (e.key in map) {
      e.preventDefault();
      const next = tabs[(i + map[e.key] + tabs.length) % tabs.length];
      selectView(next.dataset.view || 'pipeline', true);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const next = e.key === 'Home' ? tabs[0] : tabs[tabs.length - 1];
      selectView(next.dataset.view || 'pipeline', true);
    }
  }),
);

/* ── pipeline graph ─────────────────────────────────────────────────── */
const nodeButtons = $$<HTMLButtonElement>('[data-node]');
const nodePanels = $$<HTMLElement>('[data-node-panel]');
const edges = $$<SVGPathElement>('[data-edge]');

function selectNode(i: string) {
  nodeButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.node === i)));
  nodePanels.forEach((p) => { p.hidden = p.dataset.nodePanel !== i; });
  edges.forEach((e) => e.classList.toggle('is-lit', e.dataset.a === i || e.dataset.b === i));
}
nodeButtons.forEach((b) => b.addEventListener('click', () => selectNode(b.dataset.node || '0')));
selectNode(nodeButtons.find((b) => b.getAttribute('aria-pressed') === 'true')?.dataset.node || '0');

/* ── board ──────────────────────────────────────────────────────────── */
const boardEl = $<HTMLElement>('[data-board]');
const cardTemplate = $<HTMLTemplateElement>('[data-card-template]');
let nextBacklog = 0;

const columnEls = boardEl ? $$<HTMLElement>('[data-col]', boardEl) : [];
const listEls = columnEls.map((c) => $<HTMLElement>('[data-cards]', c)!);

function paintCard(card: HTMLElement, id: number, col: number) {
  card.style.setProperty('--accent', col === 4 ? COLOR.orangeMark : COLOR.mag);
  const agent = $<HTMLElement>('[data-card-agent]', card);
  if (agent) agent.textContent = cardAgent(id, col);
}

function syncCounts() {
  columnEls.forEach((c, i) => {
    const count = $<HTMLElement>('[data-col-count]', c);
    if (count) count.textContent = String(listEls[i].children.length);
  });
}

function advanceBoard() {
  if (!boardEl || !cardTemplate) return;
  // Move a card out of the fullest lane so no column starves.
  let fullest = -1;
  let size = 0;
  for (let i = 0; i < 4; i += 1) {
    const n = listEls[i].children.length;
    if (n > size) { size = n; fullest = i; }
  }
  if (fullest >= 0) {
    const pool = Array.from(listEls[fullest].children) as HTMLElement[];
    const pick = pool[Math.floor(Math.random() * pool.length)];
    const id = Number(pick.dataset.cardId);
    listEls[fullest + 1].appendChild(pick);
    paintCard(pick, id, fullest + 1);
    pick.style.animation = 'none';
    void pick.offsetWidth;
    pick.style.animation = '';
  }
  // Retire a signed-off ticket once the gate is deep.
  const gate = listEls[4];
  if (gate.children.length > 3) gate.removeChild(gate.children[0]);
  // Admit fresh tickets whenever intake runs thin.
  let guard = 0;
  while (listEls[0].children.length < 2 && guard < BACKLOG.length) {
    const t = BACKLOG[nextBacklog % BACKLOG.length];
    nextBacklog += 1;
    guard += 1;
    const titles = $$<HTMLElement>('.title', boardEl).map((el) => el.textContent);
    if (titles.includes(t.title)) continue;
    const frag = cardTemplate.content.cloneNode(true) as DocumentFragment;
    const card = frag.firstElementChild as HTMLElement;
    const id = 1000 + nextBacklog;
    card.dataset.cardId = String(id);
    $<HTMLElement>('.title', card)!.textContent = t.title;
    $<HTMLElement>('.pts', card)!.textContent = t.pts;
    paintCard(card, id, 0);
    listEls[0].appendChild(card);
    guard = 0;
  }
  syncCounts();
  bumpActions();
}

$('[data-board-advance]')?.addEventListener('click', advanceBoard);

/* ── timeline ───────────────────────────────────────────────────────── */
const rowsEl = $<HTMLElement>('[data-timeline-rows]');
const scrub = $<HTMLInputElement>('[data-timeline-scrub]');
const playBtn = $<HTMLButtonElement>('[data-timeline-play]');
const dayEl = $<HTMLElement>('[data-timeline-day]');
let playhead = DEFAULT_PLAYHEAD;
let playing = !reduceMotion;

function paintTimeline() {
  if (!rowsEl) return;
  rowsEl.style.setProperty('--playhead', `${playhead.toFixed(1)}%`);
  if (dayEl) dayEl.textContent = ((playhead / 100) * TIMELINE_DAYS).toFixed(1);
  if (scrub) scrub.value = String(Math.round(playhead));
  $$<HTMLElement>('[data-row]', rowsEl).forEach((row) => {
    let live = false;
    $$<HTMLElement>('[data-bar]', row).forEach((bar, bi) => {
      const start = Number(bar.dataset.start);
      const len = Number(bar.dataset.len);
      const state = playhead >= start + len ? 'past' : playhead >= start ? 'live' : 'future';
      if (state === 'live') live = true;
      const label = $$<HTMLElement>('[data-bar-label]', row)[bi];
      for (const el of [bar, label]) {
        if (!el) continue;
        el.classList.remove('is-past', 'is-live', 'is-future');
        el.classList.add(`is-${state}`);
      }
    });
    row.classList.toggle('is-active', live);
  });
}

function setPlaying(on: boolean) {
  playing = on;
  if (playBtn) {
    playBtn.textContent = on ? 'pause' : 'play';
    playBtn.setAttribute('aria-pressed', String(on));
  }
}
setPlaying(playing);
playBtn?.addEventListener('click', () => setPlaying(!playing));
scrub?.addEventListener('input', () => {
  playhead = Number(scrub.value);
  setPlaying(false);
  paintTimeline();
});

/* ── log ────────────────────────────────────────────────────────────── */
const logLines = $$<HTMLElement>('[data-log-line]');
const logProgress = $<HTMLElement>('[data-log-progress]');
const runBtn = $<HTMLButtonElement>('[data-log-run]');
let logTimer: number | undefined;

function paintLog() {
  logLines.forEach((l) => { l.hidden = Number(l.dataset.logLine) >= logStep; });
  if (logProgress) logProgress.textContent = `${Math.min(LOG.length, logStep)} / ${LOG.length} lines`;
  paintTicker();
}
function setRunning(on: boolean) {
  window.clearInterval(logTimer);
  logTimer = undefined;
  runBtn?.setAttribute('aria-pressed', String(on));
  if (runBtn) runBtn.textContent = on ? 'pause' : 'run all';
  if (!on) return;
  logTimer = window.setInterval(() => {
    if (logStep >= LOG.length) { setRunning(false); return; }
    logStep += 1;
    paintLog();
  }, 420);
}
$('[data-log-step]')?.addEventListener('click', () => {
  logStep = Math.min(LOG.length, logStep + 1);
  paintLog();
});
$('[data-log-reset]')?.addEventListener('click', () => {
  setRunning(false);
  logStep = 0;
  paintLog();
});
runBtn?.addEventListener('click', () => setRunning(runBtn.getAttribute('aria-pressed') !== 'true'));

/* ── org accordion + team cards ─────────────────────────────────────── */
const orgToggles = $$<HTMLButtonElement>('[data-org-toggle]');
const orgPanels = $$<HTMLElement>('[data-org-panel]');

function openOrg(i: string | null) {
  orgToggles.forEach((b) => b.setAttribute('aria-expanded', String(b.dataset.orgToggle === i)));
  orgPanels.forEach((p) => p.classList.toggle('is-open', p.dataset.orgPanel === i));
}
orgToggles.forEach((b) =>
  b.addEventListener('click', () => {
    const open = b.getAttribute('aria-expanded') === 'true';
    openOrg(open ? null : b.dataset.orgToggle || null);
  }),
);

$$<HTMLAnchorElement>('[data-team-open]').forEach((a) =>
  a.addEventListener('click', (e) => {
    const name = a.dataset.teamOpen;
    const row = name ? document.getElementById(`org-${name}`) : null;
    const toggle = row ? $<HTMLButtonElement>('[data-org-toggle]', row) : null;
    if (!toggle) return;
    e.preventDefault();
    selectView('org');
    openOrg(toggle.dataset.orgToggle || null);
    document.getElementById('console')?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    toggle.focus({ preventScroll: true });
  }),
);

/* ── FAQ accordion ──────────────────────────────────────────────────── */
const faqToggles = $$<HTMLButtonElement>('[data-faq]');
const faqPanels = $$<HTMLElement>('[data-faq-panel]');
faqToggles.forEach((b) =>
  b.addEventListener('click', () => {
    const open = b.getAttribute('aria-expanded') === 'true';
    const target = open ? null : b.dataset.faq || null;
    faqToggles.forEach((o) => o.setAttribute('aria-expanded', String(o.dataset.faq === target)));
    faqPanels.forEach((p) => p.classList.toggle('is-open', p.dataset.faqPanel === target));
  }),
);

/* ── route: drag (or click) a task into intake ──────────────────────── */
const taskButtons = $$<HTMLButtonElement>('[data-task]');
const dropZone = $<HTMLElement>('[data-drop]');
const dropLabel = $<HTMLElement>('[data-drop-label]');
const ghost = $<HTMLElement>('[data-drag-ghost]');
const ghostTitle = $<HTMLElement>('[data-drag-title]');
let routeTimer: number | undefined;
let dragTask: HTMLButtonElement | null = null;
let dragMoved = false;

function paintRoute(task: number, step: number) {
  const group = $<HTMLElement>(`[data-route-for="${task}"]`);
  $$<HTMLElement>('[data-route-for]').forEach((g) => { g.hidden = g !== group; });
  if (!group) return;
  $$<HTMLElement>('[data-chain-step]', group).forEach((item) => {
    const i = Number(item.dataset.chainStep);
    item.classList.toggle('is-done', i < step);
    item.classList.toggle('is-current', i === step);
  });
  $$<HTMLElement>('[data-note-step]', group).forEach((note) => {
    note.hidden = Number(note.dataset.noteStep) > step;
  });
}

function dispatchTask(task: number) {
  window.clearInterval(routeTimer);
  selectView('route');
  taskButtons.forEach((b) => b.setAttribute('data-dispatched', String(Number(b.dataset.task) === task)));
  if (dropLabel) dropLabel.textContent = 'dispatched — routing through the team';
  let step = 0;
  paintRoute(task, step);
  const path = ROUTES[task] || ROUTES[0];
  if (reduceMotion) { paintRoute(task, path.length - 1); return; }
  routeTimer = window.setInterval(() => {
    if (step >= path.length - 1) { window.clearInterval(routeTimer); return; }
    step += 1;
    paintRoute(task, step);
    bumpActions();
  }, 460);
}

function overDrop(x: number, y: number) {
  if (!dropZone) return false;
  const r = dropZone.getBoundingClientRect();
  return x > r.left && x < r.right && y > r.top && y < r.bottom;
}

taskButtons.forEach((b) => {
  b.addEventListener('click', () => { if (!dragMoved) dispatchTask(Number(b.dataset.task)); });
  b.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragTask = b;
    dragMoved = false;
    if (ghost && ghostTitle) {
      ghostTitle.textContent = $<HTMLElement>('.task-title', b)?.textContent || '';
      ghost.style.left = `${e.clientX}px`;
      ghost.style.top = `${e.clientY}px`;
    }
  });
});

window.addEventListener('pointermove', (e) => {
  if (!dragTask) return;
  if (!dragMoved && Math.abs(e.movementX) + Math.abs(e.movementY) === 0) return;
  dragMoved = true;
  dragTask.setAttribute('data-dragging', 'true');
  if (ghost) {
    ghost.hidden = false;
    ghost.style.left = `${e.clientX}px`;
    ghost.style.top = `${e.clientY}px`;
  }
  const over = overDrop(e.clientX, e.clientY);
  dropZone?.setAttribute('data-over', String(over));
  if (dropLabel && over) dropLabel.textContent = 'release to dispatch';
}, { passive: true });

window.addEventListener('pointerup', (e) => {
  if (!dragTask) return;
  const task = Number(dragTask.dataset.task);
  dragTask.removeAttribute('data-dragging');
  dragTask = null;
  if (ghost) ghost.hidden = true;
  dropZone?.setAttribute('data-over', 'false');
  if (dragMoved) {
    if (overDrop(e.clientX, e.clientY)) dispatchTask(task);
    else if (dropLabel) dropLabel.textContent = 'drop a task here';
    window.setTimeout(() => { dragMoved = false; }, 0);
  }
});

/* ── shared heartbeat: board shuffle + timeline playhead ────────────── */
let beat: number | undefined;
function startBeat() {
  if (reduceMotion || beat !== undefined) return;
  let ticks = 0;
  beat = window.setInterval(() => {
    ticks += 1;
    bumpActions();
    if (playing) {
      playhead = (playhead + 0.6) % 100;
      if (currentView === 'timeline') paintTimeline();
    }
    if (ticks % 8 === 0 && boardEl) advanceBoard();
  }, 260);
}
function stopBeat() {
  window.clearInterval(beat);
  beat = undefined;
}
document.addEventListener('visibilitychange', () => (document.hidden ? stopBeat() : startBeat()));
if (!document.hidden) startBeat();

// Initial paints reflect the values already rendered on the server.
paintTimeline();
paintLog();
syncCounts();
