/**
 * Contact page: three-step intake form. All steps are server-rendered; this
 * script moves between them, validates step one, mirrors the answers into
 * the review step and the draft-ticket card, and shows the confirmation.
 *
 * Submission: the form posts to /contact by default (no backend is wired
 * yet). Set `data-endpoint` on the form to a JSON endpoint to POST the
 * intake; without it the confirmation is shown locally.
 */
const $ = <T extends Element>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
const $$ = <T extends Element>(sel: string, root: ParentNode = document) => Array.from(root.querySelectorAll<T>(sel));

const form = $<HTMLFormElement>('[data-intake]');
if (form) init(form);

function init(form: HTMLFormElement) {
  const tabs = $$<HTMLElement>('[data-step-tab]', form);
  const panels = $$<HTMLFieldSetElement>('[data-step-panel]', form);
  const stepsBar = $<HTMLElement>('[data-steps]', form)!;
  const done = $<HTMLElement>('[data-done]', form)!;
  const nav = $<HTMLElement>('[data-nav]', form)!;
  const back = $<HTMLButtonElement>('[data-back]', form)!;
  const next = $<HTMLButtonElement>('[data-next]', form)!;
  const hint = $<HTMLElement>('[data-hint]', form)!;
  const store = $<HTMLInputElement>('[data-store]', form)!;
  const email = $<HTMLInputElement>('[data-email]', form)!;
  const problem = $<HTMLTextAreaElement>('[data-problem]', form)!;
  const bands = $$<HTMLInputElement>('[data-band]', form);
  const roles = $$<HTMLInputElement>('[data-role]', form);
  const sums = Object.fromEntries($$<HTMLElement>('[data-sum]', form).map((el) => [el.dataset.sum!, el]));
  const drafts = Object.fromEntries($$<HTMLElement>('[data-draft]').map((el) => [el.dataset.draft!, el]));
  const draftTitle = $<HTMLElement>('[data-draft-title]');

  let step = 0;
  let finished = false;

  const band = () => bands.find((b) => b.checked)?.value ?? '';
  const chosen = () => roles.filter((r) => r.checked).map((r) => r.dataset.roleName!);
  const canNext = () => step !== 0 || (store.value.trim().length > 2 && email.value.includes('@'));

  function setText(el: HTMLElement | undefined, text: string, empty = false) {
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('is-empty', empty);
    el.classList.toggle('dim', empty);
  }

  function mirror() {
    const s = store.value.trim();
    const e = email.value.trim();
    const p = problem.value.trim();
    const names = chosen();
    setText(sums.store, s || 'not given', !s);
    setText(sums.email, e || 'not given', !e);
    setText(sums.band, band());
    setText(sums.problem, p || 'Atlas will ask on the first call.', !p);
    setText(sums.roles, names.join(', '));
    if (draftTitle) draftTitle.textContent = p ? p.slice(0, 120) : 'Atlas is waiting for the problem statement.';
    setText(drafts.store, s || '—', !s);
    setText(drafts.band, band());
    setText(drafts.roles, `${names.length} of 10`);
    if (drafts.status) {
      drafts.status.textContent = finished ? 'received' : 'drafting';
      drafts.status.classList.toggle('accent', finished);
      drafts.status.classList.toggle('muted', !finished);
    }
    roles.forEach((r) => {
      const tag = r.closest('label')?.querySelector<HTMLElement>('[data-role-tag]');
      if (tag && !r.disabled) tag.textContent = r.checked ? 'on shift' : '';
    });
  }

  function render() {
    tabs.forEach((t, i) => {
      t.classList.toggle('is-active', !finished && i === step);
      t.classList.toggle('is-past', !finished && i < step);
      if (!finished && i === step) t.setAttribute('aria-current', 'step'); else t.removeAttribute('aria-current');
    });
    stepsBar.classList.toggle('is-done', finished);
    panels.forEach((p, i) => { p.hidden = finished || i !== step; });
    done.hidden = !finished;
    nav.hidden = finished;
    back.disabled = step === 0;
    const ok = canNext();
    next.textContent = step === 2 ? 'send to intake' : 'continue';
    next.classList.toggle('is-send', step === 2);
    next.setAttribute('aria-disabled', String(!ok));
    hint.textContent =
      step === 0 ? (ok ? 'store and email look right' : 'store url and email needed')
      : step === 1 ? `${chosen().length} roles on shift`
      : 'nothing is billed until you approve the scope';
    mirror();
  }

  async function submit() {
    finished = true;
    const id = `#${4193 + Math.floor(Math.random() * 6)}`;
    const ticket = $<HTMLElement>('[data-ticket-id]', form);
    if (ticket) ticket.textContent = id;
    const out = $<HTMLElement>('[data-email-out]', form);
    if (out) out.textContent = email.value.trim() || 'your inbox';
    const endpoint = form.dataset.endpoint;
    if (endpoint) {
      const payload = { store: store.value.trim(), email: email.value.trim(), problem: problem.value.trim(), band: band(), roles: roles.filter((r) => r.checked).map((r) => r.value) };
      fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(() => {});
    }
    render();
    done.focus();
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!canNext()) { render(); (step === 0 ? (store.value.trim().length > 2 ? email : store) : next).focus(); return; }
    if (step < 2) { step += 1; render(); panels[step].querySelector<HTMLElement>('input, button, textarea')?.focus(); return; }
    submit();
  });
  back.addEventListener('click', () => { if (step > 0) { step -= 1; render(); } });
  $<HTMLButtonElement>('[data-restart]', form)?.addEventListener('click', () => {
    finished = false; step = 0;
    store.value = ''; email.value = ''; problem.value = '';
    render(); store.focus();
  });
  form.addEventListener('input', render);
  form.addEventListener('change', render);

  render();
}

export {};
