/**
 * Client behaviour for the Pricing page. Everything it renders is already in
 * the server-rendered HTML (default estimate, every FAQ answer); this only
 * recomputes the estimate as the controls move and animates the accordion.
 */
import { estimate, money, type Cadence, type EstimatorState, DEFAULT_STATE } from '../data/pricing';

const $$ = <T extends Element>(sel: string, root: ParentNode = document) => Array.from(root.querySelectorAll<T>(sel));

/* ── estimator ─────────────────────────────────────────────────────── */
const rolesInput = document.querySelector<HTMLInputElement>('[data-roles]');
const storesInput = document.querySelector<HTMLInputElement>('[data-stores]');
const cadenceButtons = $$<HTMLButtonElement>('[data-cadence]');
const addonInputs = $$<HTMLInputElement>('[data-addon]');
const chips = $$<HTMLElement>('[data-chip]');
const roleCountEl = document.querySelector<HTMLElement>('[data-role-count]');
const storeCountEl = document.querySelector<HTMLElement>('[data-store-count]');
const totalEl = document.querySelector<HTMLElement>('[data-total]');
const closestEl = document.querySelector<HTMLElement>('[data-closest]');
const lineEls = $$<HTMLElement>('.line');

const state: EstimatorState = { ...DEFAULT_STATE, addons: [] };

function render() {
  const est = estimate(state);

  if (roleCountEl) roleCountEl.textContent = est.roleCount;
  if (storeCountEl) storeCountEl.textContent = est.storeCount;
  rolesInput?.setAttribute('aria-valuetext', est.roleCount);
  storesInput?.setAttribute('aria-valuetext', est.storeCount);

  chips.forEach((chip, i) => chip.classList.toggle('on', i < state.roles));
  cadenceButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cadence === state.cadence)));

  if (totalEl) totalEl.textContent = money(est.total);
  if (closestEl) closestEl.textContent = est.closest;

  lineEls.forEach((row, i) => {
    const line = est.lines[i];
    if (!line) return;
    const label = row.querySelector<HTMLElement>('[data-line-label]');
    const value = row.querySelector<HTMLElement>('[data-line-value]');
    if (label) label.textContent = line.label;
    if (value) value.textContent = line.value;
  });
}

rolesInput?.addEventListener('input', () => {
  state.roles = Number(rolesInput.value);
  render();
});
storesInput?.addEventListener('input', () => {
  state.stores = Number(storesInput.value);
  render();
});
cadenceButtons.forEach((b) =>
  b.addEventListener('click', () => {
    state.cadence = (b.dataset.cadence as Cadence) ?? state.cadence;
    render();
  }),
);
addonInputs.forEach((input) =>
  input.addEventListener('change', () => {
    const key = input.dataset.addon;
    if (!key) return;
    state.addons = input.checked ? [...state.addons, key] : state.addons.filter((k) => k !== key);
    render();
  }),
);

// Re-sync with whatever the browser restored on a back/forward navigation.
if (rolesInput) state.roles = Number(rolesInput.value);
if (storesInput) state.stores = Number(storesInput.value);
addonInputs.forEach((i) => {
  if (i.checked && i.dataset.addon) state.addons.push(i.dataset.addon);
});
render();

/* ── FAQ accordion ─────────────────────────────────────────────────── */
interface FaqEntry { item: HTMLElement; btn: HTMLButtonElement; panel: HTMLElement; sign: HTMLElement | null }

const faqs: FaqEntry[] = $$<HTMLElement>('[data-faq]')
  .map((item) => {
    const btn = item.querySelector<HTMLButtonElement>('.q-btn');
    const panel = item.querySelector<HTMLElement>('.panel');
    if (!btn || !panel) return null;
    return { item, btn, panel, sign: item.querySelector<HTMLElement>('.sign') };
  })
  .filter((f): f is FaqEntry => f !== null);

function paint(open: number) {
  faqs.forEach((f, i) => {
    const isOpen = i === open;
    f.item.classList.toggle('open', isOpen);
    f.btn.setAttribute('aria-expanded', String(isOpen));
    f.panel.style.maxHeight = isOpen ? `${f.panel.scrollHeight}px` : '0px';
    if (f.sign) f.sign.textContent = isOpen ? '–' : '+';
  });
}

let openFaq = faqs.findIndex((f) => f.btn.getAttribute('aria-expanded') === 'true');
if (faqs.length) {
  paint(openFaq);
  faqs.forEach((f, i) =>
    f.btn.addEventListener('click', () => {
      openFaq = openFaq === i ? -1 : i;
      paint(openFaq);
    }),
  );
  // Panel heights depend on wrapped text; re-measure when the width changes.
  window.addEventListener('resize', () => paint(openFaq));
}
