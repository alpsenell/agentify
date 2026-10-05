/**
 * Root of the client app: checks the session, then shows sign-in, the
 * offline screen, or the signed-in shell. An invitation link shows the join
 * screen whatever the session. Toasts render over everything.
 */
// Tokens and primitives first, so component styles can build on them.
import './styles/app.css';
import { useEffect } from 'react';
import { checkSession, useApp } from './state';
import { AuthScreen, BootScreen } from './auth/AuthScreen';
import { JoinScreen } from './auth/JoinScreen';
import { parse, usePathname } from './router';
import { Shell } from './shell/Shell';
import { Toaster } from './ui/toast';

export default function App() {
  const { session } = useApp();
  useEffect(() => { void checkSession(); }, []);
  const route = parse(usePathname());

  if (route.name === 'join' && session.status !== 'checking') {
    return (
      <div className="app-root">
        <JoinScreen token={route.token} me={session.status === 'ready' ? session.me : null} />
        <Toaster />
      </div>
    );
  }

  return (
    <div className="app-root">
      {session.status === 'checking' && <BootScreen />}
      {session.status === 'offline' && <BootScreen offline={session.message} onRetry={checkSession} />}
      {session.status === 'signedOut' && <AuthScreen />}
      {session.status === 'ready' && <Shell me={session.me} />}
      <Toaster />
    </div>
  );
}
