/** The Agentify wordmark used inside the app, matching the site header. */
import './ui.css';
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="app-logo" role="img" aria-label="Agentify">
      <span className="app-logo-mark" aria-hidden="true">a</span>
      {!compact && <span className="app-logo-word" aria-hidden="true">agentify</span>}
    </span>
  );
}
