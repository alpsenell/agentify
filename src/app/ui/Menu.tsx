/**
 * A small dropdown menu: a trigger button and a list of choices, with arrow
 * keys, Enter, Esc and click-outside. Used for priority and filters.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './ui.css';

export interface MenuItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  checked?: boolean;
  tone?: 'danger';
  onSelect: () => void;
}

interface MenuProps {
  /** Accessible name of the trigger. */
  label: string;
  trigger: ReactNode;
  triggerClassName?: string;
  items: MenuItem[];
  align?: 'start' | 'end';
  /** Open below the trigger (default) or above it, for menus at the bottom of the screen. */
  side?: 'bottom' | 'top';
  heading?: string;
}

export function Menu({ label, trigger, triggerClassName = 'btn ghost small', items, align = 'end', side = 'bottom', heading }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<CSSProperties>({});
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  // Fixed to the viewport, so a menu inside a clipped or scrolling container is never cut off.
  useLayoutEffect(() => {
    if (!open || !button.current || !list.current) return;
    const r = button.current.getBoundingClientRect();
    const h = list.current.offsetHeight;
    const up = side === 'top' ? r.top - h - 4 > 0 : r.bottom + h + 4 > window.innerHeight && r.top - h - 4 > 0;
    const style: CSSProperties = up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 };
    if (align === 'end') style.right = Math.max(8, window.innerWidth - r.right);
    else style.left = Math.max(8, Math.min(r.left, window.innerWidth - list.current.offsetWidth - 8));
    setPos(style);
  }, [open, align, side]);

  // Focus the list once it is placed and visible.
  useEffect(() => {
    if (open && pos.visibility !== 'hidden') list.current?.focus({ preventScroll: true });
  }, [open, pos]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!root.current?.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    const onMove = () => setOpen(false);
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open]);

  function openMenu() {
    const checked = items.findIndex((i) => i.checked);
    setActive(checked === -1 ? 0 : checked);
    setPos({ visibility: 'hidden' });
    setOpen(true);
  }

  function close(refocus = true) {
    setOpen(false);
    if (refocus) button.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + items.length) % items.length); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(items.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const item = items[active]; close(); item?.onSelect(); }
    else if (e.key === 'Tab') close(false);
  }

  return (
    <div className="menu" ref={root} onClick={(e) => e.stopPropagation()}>
      <button
        ref={button} type="button" className={triggerClassName}
        aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => (open ? close() : openMenu())}
      >
        {trigger}
      </button>
      {open && createPortal(
        <div
          ref={list} id={id} className="menu-list pop-in" style={pos}
          role="menu" aria-label={label} tabIndex={-1} onKeyDown={onKeyDown}
          aria-activedescendant={`${id}-${active}`}
        >
          {heading && <div className="menu-heading" aria-hidden="true">{heading}</div>}
          {items.map((item, i) => (
            <div
              key={item.key} id={`${id}-${i}`}
              role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
              aria-checked={item.checked}
              className="menu-item" data-active={i === active} data-tone={item.tone}
              onPointerEnter={() => setActive(i)}
              onClick={() => { close(); item.onSelect(); }}
            >
              {item.icon}
              <span className="menu-label">{item.label}</span>
              {item.checked && <span className="menu-check" aria-hidden="true">✓</span>}
            </div>
          ))}
        </div>,
        // Portalled to the app root: an ancestor with a transform would otherwise trap a fixed element.
        button.current?.closest('.app-root') ?? document.body,
      )}
    </div>
  );
}
