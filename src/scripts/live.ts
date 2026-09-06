/**
 * Client behaviour for the Live board. Everything it touches is already in
 * the server-rendered HTML; this only animates it: clock, range window,
 * queue filter, rolling activity feed and gently drifting load bars.
 */
import { FEED_LINES, hhmm } from '../data/live';

const $$ = <T extends Element>(sel: string, root: ParentNode = document) => Array.from(root.querySelectorAll<T>(sel));
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ── clock ─────────────────────────────────────────────────────────── */
const clock = document.querySelector<HTMLTimeElement>('[data-clock]');
function tickClock() {
  if (!clock) return;
  const d = new Date();
  clock.textContent = hhmm(d);
  clock.dateTime = d.toISOString();
}
tickClock();
setInterval(tickClock, 1000);

/* ── range window (24 h / 7 d / 30 d) ──────────────────────────────── */
interface RangeEntry { value: string; line: string; area: string; endX: number; endY: number }
const rangeButtons = $$<HTMLButtonElement>('[data-range]');
const tiles = $$<HTMLElement>('[data-tile]').map((el) => ({
  el,
  ranges: JSON.parse(el.dataset.ranges || '{}') as Record<string, RangeEntry>,
  value: el.querySelector<HTMLElement>('[data-tile-value]'),
  area: el.querySelector<SVGPathElement>('[data-spark-area]'),
  line: el.querySelector<SVGPathElement>('[data-spark-line]'),
  end: el.querySelector<SVGLineElement>('[data-spark-end]'),
}));
let rangeLabel = rangeButtons.find((b) => b.getAttribute('aria-pressed') === 'true')?.textContent?.trim() ?? '24 h';

function applyRange(days: string, label: string) {
  rangeLabel = label;
  rangeButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === days)));
  for (const t of tiles) {
    const cur = t.ranges[days];
    if (!cur) continue;
    if (t.value) t.value.textContent = cur.value;
    t.area?.setAttribute('d', cur.area);
    t.line?.setAttribute('d', cur.line);
    if (t.end) {
      t.end.setAttribute('x1', String(cur.endX)); t.end.setAttribute('x2', String(cur.endX));
      t.end.setAttribute('y1', String(cur.endY)); t.end.setAttribute('y2', String(cur.endY));
    }
  }
  updateQueueNote();
}
rangeButtons.forEach((b) =>
  b.addEventListener('click', () => applyRange(b.dataset.range || '1', b.textContent?.trim() || '24 h')),
);

/* ── queue filter ──────────────────────────────────────────────────── */
const filterButtons = $$<HTMLButtonElement>('[data-filter]');
const rows = $$<HTMLTableRowElement>('tr[data-kind]');
const queueNote = document.querySelector<HTMLElement>('[data-queue-note]');

function updateQueueNote() {
  if (!queueNote) return;
  const shown = rows.filter((r) => !r.hidden).length;
  queueNote.textContent = `${shown} of ${rows.length} tickets · ${rangeLabel} window · anonymised across pilots`;
}
function applyFilter(kind: string) {
  filterButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === kind)));
  rows.forEach((r) => { r.hidden = kind !== 'all' && r.dataset.kind !== kind; });
  updateQueueNote();
}
filterButtons.forEach((b) => b.addEventListener('click', () => applyFilter(b.dataset.filter || 'all')));

/* ── activity feed ─────────────────────────────────────────────────── */
const feed = document.querySelector<HTMLOListElement>('[data-feed]');
const countEl = document.querySelector<HTMLElement>('[data-event-count]');
const tpl = document.querySelector<HTMLTemplateElement>('#feed-item');
let eventCount = Number(countEl?.textContent) || 0;

// Re-anchor the pre-rendered times to the viewer's clock.
if (feed) {
  const items = $$<HTMLElement>('li', feed);
  items.forEach((li, i) => {
    const t = li.querySelector<HTMLTimeElement>('time');
    if (!t) return;
    const d = new Date(Date.now() - (items.length - i) * 210000);
    t.textContent = hhmm(d);
    t.dateTime = d.toISOString();
  });
}

function pushFeed() {
  if (!feed || !tpl) return;
  const [agent, text] = FEED_LINES[Math.floor(Math.random() * FEED_LINES.length)];
  const li = (tpl.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
  const d = new Date();
  const time = li.querySelector<HTMLTimeElement>('time')!;
  time.textContent = hhmm(d);
  time.dateTime = d.toISOString();
  li.querySelector('.agent')!.textContent = agent;
  li.querySelector('.text')!.textContent = text;
  li.classList.toggle('is-you', agent === 'You');
  while (feed.children.length >= 9) feed.firstElementChild?.remove();
  feed.append(li);
  eventCount += 1;
  if (countEl) countEl.textContent = String(eventCount);
}

/* ── drifting load bars ────────────────────────────────────────────── */
const agents = $$<HTMLElement>('[data-agent]').map((el) => ({
  el,
  stalled: el.dataset.stalled === 'true',
  load: Number(el.dataset.load) || 0.5,
  bar: el.querySelector<HTMLElement>('[data-load-bar]'),
  pct: el.querySelector<HTMLElement>('[data-load-pct]'),
}));

function driftLoads() {
  for (const a of agents) {
    a.load = Math.max(0.12, Math.min(0.97, a.load + (Math.random() - 0.5) * 0.16));
    const pct = Math.round(a.load * 100);
    a.el.style.setProperty('--load', String(a.load));
    a.el.classList.toggle('is-hot', !a.stalled && a.load > 0.8);
    a.el.classList.toggle('is-idle', !a.stalled && a.load < 0.25);
    a.bar?.setAttribute('aria-valuenow', String(pct));
    if (a.pct) a.pct.textContent = `${pct}%`;
  }
}

/* ── timers, paused while the tab is hidden ────────────────────────── */
let feedTimer: number | undefined;
let loadTimer: number | undefined;
function start() {
  stop();
  feedTimer = window.setInterval(pushFeed, 2600);
  if (!reduceMotion) loadTimer = window.setInterval(driftLoads, 2200);
}
function stop() {
  if (feedTimer) clearInterval(feedTimer);
  if (loadTimer) clearInterval(loadTimer);
  feedTimer = loadTimer = undefined;
}
document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
start();
