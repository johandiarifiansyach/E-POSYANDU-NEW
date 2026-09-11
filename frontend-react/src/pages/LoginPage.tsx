import { type FormEvent, useEffect, useRef, useState } from 'react';
import { APP_VERSION } from '../config/app';
import {
  getPreferredColorScheme,
  saveColorScheme,
  subscribeColorScheme,
  type ColorScheme
} from '../theme/colorScheme';
import ReleaseNotesDialog from '../components/ReleaseNotesDialog';

export type LoginPageProps = {
  onLogin: (username: string, password: string, turnstileToken?: string) => Promise<void>;
};

type TurnstileOptions = {
  sitekey: string;
  action: string;
  size: 'flexible';
  appearance: 'always';
  theme: ColorScheme;
  callback: (token: string) => void;
  'expired-callback': () => void;
  'error-callback': () => void;
};

type TurnstileApi = {
  render: (container: HTMLElement, options: TurnstileOptions) => string;
  remove: (widgetId: string) => void;
  reset: (widgetId: string) => void;
};

type TurnstileWindow = Window & { turnstile?: TurnstileApi };

const turnstileSiteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim() || '';

function LoginSymbol(props: React.SVGProps<SVGSVGElement>) {
  return <svg
    className="login-symbol"
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  />;
}

export default function LoginPage({ onLogin }: LoginPageProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [colorScheme, setColorScheme] = useState<ColorScheme>(() => getPreferredColorScheme());
  const [turnstileToken, setTurnstileToken] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const turnstileContainerRef = useRef<HTMLDivElement | null>(null);
  const turnstileWidgetRef = useRef<string | null>(null);
  const turnstileTokenRef = useRef('');

  useEffect(() => subscribeColorScheme(setColorScheme), []);

  useEffect(() => {
    const container = turnstileContainerRef.current;
    if (!turnstileSiteKey || !container) return undefined;

    const api = () => (window as TurnstileWindow).turnstile;
    const renderWidget = () => {
      const currentApi = api();
      if (!currentApi || turnstileWidgetRef.current) return;
      turnstileWidgetRef.current = currentApi.render(container, {
        sitekey: turnstileSiteKey,
        action: 'login',
        size: 'flexible',
        appearance: 'always',
        theme: colorScheme,
        callback: (token) => {
          turnstileTokenRef.current = token;
          setTurnstileToken(token);
          setError('');
        },
        'expired-callback': () => {
          turnstileTokenRef.current = '';
          setTurnstileToken('');
        },
        'error-callback': () => {
          turnstileTokenRef.current = '';
          setTurnstileToken('');
          setError('Verifikasi keamanan belum siap. Coba lagi.');
        }
      });
    };

    let script = document.getElementById('cloudflare-turnstile') as HTMLScriptElement | null;
    const createdScript = !script;
    if (!script) {
      script = document.createElement('script');
      script.id = 'cloudflare-turnstile';
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      document.head.append(script);
    }
    const handleLoad = () => renderWidget();
    const handleError = () => setError('Verifikasi keamanan gagal dimuat. Periksa koneksi internet lalu muat ulang halaman.');
    script.addEventListener('load', handleLoad);
    script.addEventListener('error', handleError);
    renderWidget();

    return () => {
      script?.removeEventListener('load', handleLoad);
      script?.removeEventListener('error', handleError);
      if (turnstileWidgetRef.current) api()?.remove(turnstileWidgetRef.current);
      turnstileWidgetRef.current = null;
      turnstileTokenRef.current = '';
      setTurnstileToken('');
      if (createdScript) script?.remove();
    };
  }, [colorScheme]);

  useEffect(() => {
    const input = document.querySelector<HTMLInputElement>('[data-react-login-username]');
    input?.focus({ preventScroll: true });
  }, []);

  const toggleTheme = () => saveColorScheme(colorScheme === 'dark' ? 'light' : 'dark');

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (turnstileSiteKey && !turnstileTokenRef.current) {
      setError('Selesaikan verifikasi keamanan sebelum masuk.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await onLogin(username.trim(), password, turnstileTokenRef.current || undefined);
    } catch (cause) {
      console.error('Gagal masuk:', cause);
      setError(cause instanceof Error ? cause.message : 'Tidak dapat masuk ke aplikasi.');
      if (turnstileWidgetRef.current) {
        (window as TurnstileWindow).turnstile?.reset(turnstileWidgetRef.current);
        turnstileTokenRef.current = '';
        setTurnstileToken('');
      }
      setSubmitting(false);
    }
  };

  const darkMode = colorScheme === 'dark';
  const themeLabel = darkMode ? 'Gunakan mode terang' : 'Gunakan mode gelap';

  return <div className="login-shell">
    {releaseNotesOpen ? <ReleaseNotesDialog onClose={() => setReleaseNotesOpen(false)} /> : null}
    <div className="login-batik-background" aria-hidden="true" />
    <button
      data-theme-toggle="true"
      type="button"
      className="login-theme-toggle"
      title={themeLabel}
      aria-label={themeLabel}
      aria-pressed={darkMode}
      onClick={toggleTheme}
    >
      {darkMode ? <LoginSymbol width={21} height={21} strokeWidth={1.9}>
        <circle cx="12" cy="12" r="3.6" />
        <path d="M12 2.3v2.1M12 19.6v2.1M4.4 4.4l1.5 1.5M18.1 18.1l1.5 1.5M2.3 12h2.1M19.6 12h2.1M4.4 19.6l1.5-1.5M18.1 5.9l1.5-1.5" />
      </LoginSymbol> : <LoginSymbol width={21} height={21} strokeWidth={1.9}>
        <path d="M20.6 15.1A8.7 8.7 0 0 1 8.9 3.4 8.8 8.8 0 1 0 20.6 15.1Z" />
      </LoginSymbol>}
    </button>
    <main className="login-stage">
      <div className="login-stack">
        <section className="login-glass-card" aria-labelledby="react-login-title">
          <div className="login-brand">
            <div className="login-logo-shell">
              <img src="/logo-puskesmas-32981.svg" alt="Logo Puskesmas Gumukmas" className="h-11 w-11 object-contain" width={44} height={44} loading="eager" decoding="async" />
            </div>
            <h1 id="react-login-title" className="login-title">E-Posyandu</h1>
            <p className="login-organization">UPTD Puskesmas Gumukmas</p>
            <div className="login-brand-rule" aria-hidden="true"><span /><span /><span /></div>
          </div>
          <form className="login-form" onSubmit={handleSubmit}>
            <label className="login-field">
              <span>Username</span>
              <input
                data-react-login-username="true"
                required
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>
            <div className="login-field">
              <label htmlFor="react-login-password">Kata Sandi</label>
              <div className="login-password-field">
                <input
                  id="react-login-password"
                  required
                  type={passwordVisible ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <button
                  type="button"
                  className="login-password-toggle"
                  title={passwordVisible ? 'Sembunyikan kata sandi' : 'Perlihatkan kata sandi'}
                  aria-label={passwordVisible ? 'Sembunyikan kata sandi' : 'Perlihatkan kata sandi'}
                  onClick={() => setPasswordVisible((visible) => !visible)}
                >
                  {passwordVisible ? <LoginSymbol width={18} height={18} strokeWidth={1.8}>
                    <path d="M4.2 8.55C3.05 9.65 2.5 12 2.5 12s3.45 5.75 9.5 5.75c1.35 0 2.6-.28 3.7-.72M8.1 6.7A10.6 10.6 0 0 1 12 6.25c6.05 0 9.5 5.75 9.5 5.75a12 12 0 0 1-2.05 2.8" />
                    <path d="M9.8 9.75a3.05 3.05 0 0 0 4.45 4.4M3.2 3.2l17.6 17.6" />
                  </LoginSymbol> : <LoginSymbol width={18} height={18} strokeWidth={1.8}>
                    <path d="M2.5 12s3.45-5.75 9.5-5.75S21.5 12 21.5 12s-3.45 5.75-9.5 5.75S2.5 12 2.5 12Z" />
                    <circle cx="12" cy="12" r="2.75" />
                  </LoginSymbol>}
                </button>
              </div>
            </div>
            <div ref={turnstileContainerRef} className="login-turnstile" hidden={!turnstileSiteKey} />
            {error ? <p role="alert" className="login-error">{error}</p> : null}
            <button data-submit="true" type="submit" className="login-submit" disabled={submitting || Boolean(turnstileSiteKey && !turnstileToken)}>
              <span data-submit-label="true">{submitting ? 'Memproses...' : 'Masuk'}</span>
            </button>
          </form>
        </section>
      </div>
    </main>
    <footer className="login-footer">
      <p>© 2026 UPTD Puskesmas Gumukmas Developed by Johandi Arifiansyach</p>
      <button
        type="button"
        className="app-version-button login-version-button"
        aria-haspopup="dialog"
        title="Lihat apa yang baru"
        onClick={() => setReleaseNotesOpen(true)}
      >E-Posyandu v{APP_VERSION}</button>
    </footer>
  </div>;
}
