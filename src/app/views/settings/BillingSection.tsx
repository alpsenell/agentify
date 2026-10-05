/**
 * Settings → Plan & usage: the current plan and its state, a usage meter for
 * this period, and the plans on offer. Buying goes through Stripe Checkout
 * (or Stripe's confirm page when switching an existing subscription); the
 * browser comes back to /dashboard/settings?billing=<flag>#billing.
 * Members see everything read-only; only the owner can buy or manage.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { Me, PlanState, Tier } from '../../../agency/types';
import { formatTokens } from '../../../agency/plans';
import { api, type Billing, type PlanOffer } from '../../api';
import { refreshMe } from '../../state';
import { Icon } from '../../ui/Icon';
import { toast } from '../../ui/toast';
import './billing.css';

const DAY = 86_400_000;
/** Rough size of one full request, to put token ceilings in human terms. */
const TOKENS_PER_REQUEST = 400_000;
const TIER_NAME: Record<Tier, string> = { trial: 'Trial', pilot: 'Pilot', team: 'Team', studio: 'Studio' };
const RANK: Record<Tier, number> = { trial: 0, pilot: 1, team: 2, studio: 3 };

const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.');
const day = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const RETURN_TOAST: Record<string, [string, 'ok' | 'info']> = {
  success: ['Payment received. Your plan switches over as soon as Stripe confirms it — usually a few seconds.', 'ok'],
  updated: ['Plan change confirmed. It shows here as soon as Stripe confirms it.', 'ok'],
  canceled: ['Checkout cancelled. Nothing was charged.', 'info'],
  portal: ['Back from billing. Any changes show here once Stripe confirms them.', 'info'],
};

/** Plan status as a label, a tone and a sentence. */
function describe(plan: PlanState, now: number): { label: string; tone: 'ok' | 'warn' | 'danger' | 'info'; line: string } {
  if (plan.tier === 'trial') {
    const left = Math.ceil((plan.periodEnd - now) / DAY);
    return left > 0
      ? { label: `${plural(left, 'day')} left`, tone: left <= 3 ? 'warn' : 'info', line: `Your free trial ends on ${day(plan.periodEnd)}. Choose a plan to keep the team working after that.` }
      : { label: 'Trial ended', tone: 'danger', line: `The trial ended on ${day(plan.periodEnd)}. The team is paused until you choose a plan; your requests are saved.` };
  }
  switch (plan.status) {
    case 'active': case 'trialing':
      return { label: 'Active', tone: 'ok', line: `Usage resets on ${day(plan.periodEnd)}.` };
    case 'past_due':
      return { label: 'Payment failed', tone: 'warn', line: 'The last payment did not go through. Stripe will retry; update the card in Manage billing to keep the team working.' };
    case 'canceled':
      return { label: 'Inactive', tone: 'danger', line: 'This plan is no longer active, so the team is paused. Choose a plan to restart it; nothing has been deleted.' };
  }
}

export default function BillingSection({ me }: { me: Me }) {
  const [billing, setBilling] = useState<Billing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Tier | 'portal' | null>(null);
  const id = useId();
  const owner = me.user.role === 'owner';
  const canBuy = owner && me.capabilities.billing;

  const load = useCallback(async () => {
    try {
      const next = await api.billing();
      setBilling(next);
      setLoadError(null);
      return next;
    } catch (err) {
      setLoadError(errorText(err));
      return null;
    }
  }, []);

  // First load, and the return from Stripe: say what happened, then wait for the webhook to land.
  const handledReturn = useRef(false);
  useEffect(() => {
    let stop = false;
    void (async () => {
      const first = await load();
      if (handledReturn.current) return;
      handledReturn.current = true;
      const url = new URL(window.location.href);
      const flag = url.searchParams.get('billing');
      if (!flag) return;
      url.searchParams.delete('billing');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      const [message, tone] = RETURN_TOAST[flag] ?? RETURN_TOAST.portal!;
      toast(message, tone);
      if (flag !== 'success' && flag !== 'updated') return;
      const before = JSON.stringify(first?.plan);
      for (let i = 0; i < 8 && !stop; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const next = await load();
        if (next && JSON.stringify(next.plan) !== before) {
          toast(`You’re on ${TIER_NAME[next.plan.tier]} now.`, 'ok');
          await refreshMe();
          return;
        }
      }
    })();
    return () => { stop = true; };
  }, [load]);

  async function buy(offer: PlanOffer) {
    setBusy(offer.tier);
    try {
      const { url } = await api.checkout(offer.tier);
      window.location.assign(url);
    } catch (err) {
      toast(errorText(err), 'danger');
      setBusy(null);
    }
  }

  async function portal() {
    setBusy('portal');
    try {
      const { url } = await api.billingPortal();
      window.location.assign(url);
    } catch (err) {
      toast(errorText(err), 'danger');
      setBusy(null);
    }
  }

  const now = Date.now();
  const plan = billing?.plan ?? me.workspace.plan;
  const usage = billing?.usage ?? me.usage;
  const status = describe(plan, now);
  const paid = plan.tier !== 'trial';
  const subscribed = paid && (plan.status === 'active' || plan.status === 'past_due');

  return (
    <section className="set-section card fade-in" aria-labelledby={`${id}-t`}>
      <div className="set-intro">
        <h2 id={`${id}-t`} className="section-title">Plan &amp; usage</h2>
        <p className="section-sub">The agents’ model time is metered in tokens. When a period’s allowance runs out the team pauses until it renews or you upgrade.</p>
      </div>
      <div className="set-body">
        <div className="bill-current">
          <div className="bill-current-head">
            <strong className="bill-plan-name">{TIER_NAME[plan.tier]}</strong>
            <span className="tag" data-tone={status.tone}>{status.label}</span>
            {canBuy && paid && (
              <button type="button" className="btn small bill-manage" onClick={() => void portal()} disabled={busy !== null}>
                {busy === 'portal' ? <span className="spinner" aria-hidden="true" /> : <Icon name="external" size={13} />} Manage billing
              </button>
            )}
          </div>
          <p className="hint bill-status-line">{status.line}</p>
          <Meter tokens={usage.tokens} limit={usage.tokenLimit} steps={usage.steps} trial={plan.tier === 'trial'} />
        </div>

        {loadError && (
          <div className="banner" data-tone="warn" role="alert">
            <span>Couldn’t load the plans: {loadError}</span>
            <button type="button" className="btn small" onClick={() => void load()}>Retry</button>
          </div>
        )}
        {!me.capabilities.billing && (
          <div className="banner" data-tone="info"><span>Billing isn’t connected on this server, so plans can’t be bought here. To change plans, <a href="/contact">contact us</a>.</span></div>
        )}

        <div className="bill-offers" role="list" aria-label="Plans">
          {billing === null && !loadError && [0, 1, 2].map((i) => <div key={i} className="bill-offer skeleton" role="listitem" aria-hidden="true" />)}
          {billing?.offers.map((offer) => {
            const current = offer.tier === plan.tier;
            const up = RANK[offer.tier] > RANK[plan.tier];
            const label = !subscribed ? `Choose ${offer.name}` : up ? `Upgrade to ${offer.name}` : `Switch to ${offer.name}`;
            return (
              <div key={offer.tier} className="bill-offer" role="listitem" data-current={current || undefined}>
                <div className="bill-offer-head">
                  <span className="bill-offer-name">{offer.name}</span>
                  {current && <span className="tag" data-tone="accent">Current plan</span>}
                </div>
                <div className="bill-price">
                  {offer.price ? <><strong>{offer.price}</strong><span>{offer.unit.replace(/^per month/, '/ month')}</span></> : <><strong>Custom</strong><span>{offer.unit}</span></>}
                </div>
                <ul className="bill-limits">
                  <li><Icon name="spark" size={13} /> {formatTokens(offer.tokenLimit)} tokens a month <span className="hint">· about {plural(Math.max(1, Math.round(offer.tokenLimit / TOKENS_PER_REQUEST)), 'full request')}</span></li>
                  <li><Icon name="store" size={13} /> {plural(offer.storeLimit, 'store')} <span className="hint">· each environment counts</span></li>
                  <li><Icon name="team" size={13} /> {plural(offer.memberLimit, 'seat')}</li>
                </ul>
                <div className="bill-offer-action">
                  {current && plan.status !== 'canceled' ? (
                    <span className="hint"><Icon name="check" size={13} /> You’re on this plan</span>
                  ) : !offer.purchasable ? (
                    <a className="btn" href="/contact">Talk to us</a>
                  ) : canBuy ? (
                    <button type="button" className={`btn ${up || !subscribed ? 'primary' : ''}`} disabled={busy !== null} onClick={() => void buy(offer)}>
                      {busy === offer.tier && <span className="spinner" aria-hidden="true" />} {busy === offer.tier ? 'Opening Stripe…' : current ? `Restart ${offer.name}` : label}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        {canBuy && subscribed && <p className="hint">Switching plans opens Stripe to confirm the change and any proration before anything is charged.</p>}
      </div>
    </section>
  );
}

function Meter({ tokens, limit, steps, trial }: { tokens: number; limit: number; steps: number; trial: boolean }) {
  const pct = limit > 0 ? Math.min(100, (tokens / limit) * 100) : 0;
  const tone = pct >= 95 ? 'danger' : pct >= 75 ? 'warn' : 'ok';
  const shown = pct > 0 && pct < 1 ? '<1' : Math.floor(pct).toString();
  return (
    <div className="bill-meter" data-tone={tone}>
      <div className="bill-meter-row">
        <span><strong>{formatTokens(tokens)}</strong> of {formatTokens(limit)} tokens</span>
        <span className="bill-meter-pct">{shown}%</span>
      </div>
      <div className="bill-meter-track" role="meter" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(tokens, limit)}
        aria-valuetext={`${formatTokens(tokens)} of ${formatTokens(limit)} tokens used`} aria-label="Tokens used this period">
        <div className="bill-meter-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="hint">
        {plural(steps, 'agent step')} {trial ? 'during the trial' : 'this period'}
        {tone === 'danger' && ' · the team pauses when the allowance runs out'}
        {tone === 'warn' && ' · getting close to the allowance'}
      </div>
    </div>
  );
}
