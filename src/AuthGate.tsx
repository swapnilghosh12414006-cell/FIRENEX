import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { AlertTriangle, Eye, EyeOff, LockKeyhole, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, type AuthSession } from './api';
import WirelessCameras from './WirelessCameras';

type AuthGateProps = {
  children: (onLogout: () => void) => ReactNode;
};

export default function AuthGate({ children }: AuthGateProps) {
  const [pairedViewerLink] = useState(() => {
    const pairing = new URLSearchParams(window.location.hash.slice(1));
    return Boolean(pairing.get('camera')?.trim() && pairing.get('token')?.trim());
  });
  const [session, setSession] = useState<AuthSession | null>(null);
  const [checking, setChecking] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [serviceError, setServiceError] = useState('');

  const refreshSession = useCallback(async () => {
    setChecking(true);
    setServiceError('');
    try {
      setSession(await api.authSession());
    } catch (error) {
      setServiceError(error instanceof Error ? error.message : 'Could not reach the Emberwatch API.');
      setSession(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (pairedViewerLink) return;
    void refreshSession();
    const handleUnauthorized = () => {
      setSession((current) => current
        ? { ...current, authenticated: false, username: null }
        : current);
      setMessage('Your session expired. Sign in again.');
    };
    window.addEventListener('emberwatch:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('emberwatch:unauthorized', handleUnauthorized);
  }, [pairedViewerLink, refreshSession]);

  const submitLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const result = await api.login(username, password);
      setSession({ configured: true, authenticated: true, username: result.username });
      setPassword('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  const logout = useCallback(async () => {
    setBusy(true);
    try {
      await api.logout();
      setPassword('');
      setMessage('You have signed out.');
      setSession({ configured: true, authenticated: false, username: null });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not sign out. Check the API connection.');
    } finally {
      setBusy(false);
    }
  }, []);

  if (pairedViewerLink) {
    return (
      <main className="camera-viewer-shell">
        <WirelessCameras viewerOnly />
      </main>
    );
  }

  if (checking) {
    return <main className="auth-page"><div className="auth-loading"><span className="auth-spinner" />Checking secure session…</div></main>;
  }

  if (session?.authenticated) return children(logout);

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="auth-title">
        <img className="auth-logo" src="/emberwatch-logo.png" alt="Emberwatch" />
        <div className="auth-security"><ShieldCheck size={15} /> SECURE OPERATOR ACCESS</div>
        {serviceError ? (
          <>
            <h1 id="auth-title">Backend unavailable</h1>
            <p className="auth-description">Connect to the Emberwatch API to sign in.</p>
            <div className="auth-message" role="alert"><AlertTriangle size={16} />{serviceError}</div>
            <button className="auth-submit" onClick={() => void refreshSession()}><RefreshCw size={16} />Retry connection</button>
          </>
        ) : !session?.configured ? (
          <>
            <h1 id="auth-title">Set up operator login</h1>
            <p className="auth-description">For security, the dashboard stays locked until backend credentials are configured.</p>
            <div className="auth-setup" role="status">
              <strong>Configure on the backend</strong>
              <span>Set <code>EMBERWATCH_ADMIN_USERNAME</code> and <code>EMBERWATCH_ADMIN_PASSWORD</code> in <code>backend\.env</code>. Use a password with at least 12 characters, then restart FastAPI.</span>
            </div>
            <button className="auth-submit" onClick={() => void refreshSession()}><RefreshCw size={16} />Check configuration</button>
          </>
        ) : (
          <>
            <h1 id="auth-title">Welcome back</h1>
            <p className="auth-description">Sign in to access the Emberwatch safety monitoring dashboard.</p>
            <form className="auth-form" onSubmit={(event) => void submitLogin(event)}>
              <label>
                <span>Operator username</span>
                <input
                  autoComplete="username"
                  autoFocus
                  maxLength={128}
                  onChange={(event) => setUsername(event.target.value)}
                  required
                  value={username}
                />
              </label>
              <label>
                <span>Password</span>
                <div className="auth-password-field">
                  <LockKeyhole size={16} />
                  <input
                    autoComplete="current-password"
                    maxLength={256}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                  />
                  <button
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    onClick={() => setShowPassword((shown) => !shown)}
                    type="button"
                  >{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button>
                </div>
              </label>
              {message && <div className="auth-message" role="alert"><AlertTriangle size={16} />{message}</div>}
              <button className="auth-submit" disabled={busy} type="submit">
                <LockKeyhole size={16} />{busy ? 'Signing in…' : 'Sign in securely'}
              </button>
            </form>
          </>
        )}
        <p className="auth-footnote">Decision support only · keep certified fire alarms active</p>
      </section>
    </main>
  );
}
