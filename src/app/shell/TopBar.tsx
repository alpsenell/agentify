/**
 * The bar above each view: title, List | Board switch, search, and the
 * New request button. On small screens it also opens the sidebar drawer.
 */
import type { RefObject } from 'react';
import { linkClick, paths } from '../router';
import { Icon } from '../ui/Icon';

interface Props {
  title: string;
  subtitle?: string;
  switcher?: 'list' | 'board';
  search?: { value: string; onChange: (v: string) => void; inputRef: RefObject<HTMLInputElement | null> };
  onNew: () => void;
  onMenu: () => void;
}

export function TopBar({ title, subtitle, switcher, search, onNew, onMenu }: Props) {
  return (
    <header className="topbar">
      <div className="topbar-row">
        <button type="button" className="btn ghost icon topbar-menu" onClick={onMenu} aria-label="Open menu">
          <Icon name="menu" />
        </button>
        <div className="topbar-title">
          <h1>{title}</h1>
          {subtitle && <span className="topbar-sub">{subtitle}</span>}
        </div>
        {switcher && (
          <nav className="view-switch" aria-label="View">
            <a href={paths.list()} onClick={linkClick} aria-current={switcher === 'list' ? 'page' : undefined}><Icon name="list" size={14} /> List</a>
            <a href={paths.board()} onClick={linkClick} aria-current={switcher === 'board' ? 'page' : undefined}><Icon name="board" size={14} /> Board</a>
            <span className="view-switch-ink" data-at={switcher} aria-hidden="true" />
          </nav>
        )}
        <div className="topbar-spacer" />
        {search && (
          <div className="search">
            <Icon name="search" size={14} className="search-icon" />
            <input
              ref={search.inputRef} type="search" className="search-input" placeholder="Search requests"
              aria-label="Search requests" value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape' && search.value) { e.stopPropagation(); search.onChange(''); } else if (e.key === 'Escape') e.currentTarget.blur(); }}
            />
            <kbd className="search-kbd" aria-hidden="true">/</kbd>
          </div>
        )}
        <button type="button" className="btn primary new-btn" onClick={onNew} title="New request (C)">
          <Icon name="plus" size={15} /> <span className="new-btn-text">New request</span>
        </button>
      </div>
    </header>
  );
}
