/**
 * Toasts: short notices in the corner. Call `toast(message, tone?)` from
 * anywhere in the app; <Toaster /> (mounted once by App) renders them.
 */
import { useSyncExternalStore } from 'react';
import './toast.css';

export type ToastTone = 'info' | 'ok' | 'warn' | 'danger';

interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
  leaving: boolean;
}

let toasts: Toast[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());
const set = (next: Toast[]) => { toasts = next; emit(); };

function dismiss(id: number) {
  if (!toasts.some((t) => t.id === id && !t.leaving)) return;
  set(toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
  // Remove after the exit animation.
  window.setTimeout(() => set(toasts.filter((t) => t.id !== id)), 200);
}

/** Show a toast. Errors stay longer than confirmations. */
export function toast(message: string, tone: ToastTone = 'info'): void {
  const id = ++seq;
  // Collapse an identical toast that is already showing.
  const same = toasts.find((t) => t.message === message && !t.leaving);
  if (same) dismiss(same.id);
  set([...toasts.slice(-3), { id, message, tone, leaving: false }]);
  window.setTimeout(() => dismiss(id), tone === 'danger' ? 7000 : 4500);
}

const subscribe = (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); };

export function Toaster() {
  const list = useSyncExternalStore(subscribe, () => toasts);
  return (
    <div className="toaster" role="region" aria-label="Notifications">
      {list.map((t) => (
        <div
          key={t.id}
          className={`toast${t.leaving ? ' leaving' : ''}`}
          data-tone={t.tone}
          role={t.tone === 'danger' ? 'alert' : 'status'}
        >
          <span className="toast-dot" aria-hidden="true" />
          <span className="toast-msg">{t.message}</span>
          <button type="button" className="toast-x" aria-label="Dismiss" onClick={() => dismiss(t.id)}>×</button>
        </div>
      ))}
    </div>
  );
}
