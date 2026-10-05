/**
 * An accessible dialog: animated open and close, focus moved in and trapped,
 * focus returned on close, Esc to close, page scroll locked. `variant`
 * "sheet" is the large request frame; "dialog" is a centred card.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import './ui.css';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
const EXIT_MS = 200;

let locks = 0;
function lockScroll() {
  if (locks++ === 0) document.documentElement.style.overflow = 'hidden';
  return () => { if (--locks === 0) document.documentElement.style.overflow = ''; };
}

/** Keep children mounted for the exit animation after `open` turns false. */
export function usePresence(open: boolean, ms = EXIT_MS): boolean {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) { setMounted(true); return; }
    const t = window.setTimeout(() => setMounted(false), ms);
    return () => window.clearTimeout(t);
  }, [open, ms]);
  return open || mounted;
}

interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name, unless `labelledBy` points at a visible heading. */
  label?: string;
  labelledBy?: string;
  variant?: 'dialog' | 'sheet';
  className?: string;
  children: ReactNode;
}

export function Modal(props: ModalProps) {
  const present = usePresence(props.open);
  return present ? <ModalPanel {...props} /> : null;
}

function ModalPanel({ open, onClose, label, labelledBy, variant = 'dialog', className, children }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = panel.current!;
    const first = node.querySelector<HTMLElement>('[data-autofocus]') ?? node;
    first.focus({ preventScroll: true });
    const unlock = lockScroll();
    return () => {
      unlock();
      // Only hand focus back if it is still inside the closing dialog or lost to <body>.
      const active = document.activeElement;
      if (previous?.isConnected && (!active || active === document.body || node.contains(active))) previous.focus({ preventScroll: true });
    };
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      closeRef.current();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [...panel.current!.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (items.length === 0) { e.preventDefault(); return; }
    const first = items[0]!, last = items.at(-1)!;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  return (
    <div className={`modal-layer ${variant}`} data-state={open ? 'open' : 'closed'} onKeyDown={onKeyDown}>
      <div className="modal-scrim" onClick={() => closeRef.current()} aria-hidden="true" />
      <div
        ref={panel}
        className={`modal-panel ${className ?? ''}`}
        role="dialog" aria-modal="true" aria-label={label} aria-labelledby={labelledBy}
        tabIndex={-1}
        inert={!open}
      >
        {children}
      </div>
    </div>
  );
}
