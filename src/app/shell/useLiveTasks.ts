/**
 * Keeps task summaries fresh while the app is open: on mount, when the window
 * regains focus or becomes visible, and on a modest interval while visible.
 */
import { useEffect } from 'react';
import { refreshTasks } from '../state';

const INTERVAL_MS = 20_000;

export function useLiveTasks(): void {
  useEffect(() => {
    void refreshTasks();
    const onVisible = () => { if (document.visibilityState === 'visible') void refreshTasks(); };
    const timer = window.setInterval(onVisible, INTERVAL_MS);
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
}
