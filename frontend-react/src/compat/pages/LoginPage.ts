import { APP_VERSION } from '../config/app';
import { createElement as h, type DomChild } from '../runtime/dom';
import { getPreferredColorScheme, saveColorScheme, subscribeColorScheme, type ColorScheme } from '../theme/colorScheme';
import { closeReleaseNotes, openReleaseNotes } from '../ui/releaseNotes';

type LoginHandler = (username: string, password: string, turnstileToken?: string) => Promise<void>;

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

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, options: TurnstileOptions) => string;
      remove: (widgetId: string) => void;
      reset: (widgetId: string) => void;
    };
  }
}

const turnstileSiteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim() || '';

function requiredElement<T extends Element>(container: ParentNode, selector: string): T {
  const element = container.querySelector<T>(selector);
  if (!element) throw new Error(`Elemen login tidak ditemukan: ${selector}`);
  return element;
}

function loginSymbol(props: Record<string, unknown>, children: DomChild[]) {
  return h('svg', {
    className: 'login-symbol',
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    ...props
  }, children);
}

function loginView() {
  const moon = loginSymbol({ 'data-theme-moon': true, width: 21, height: 21, strokeWidth: 1.9 }, [
    h('path', { d: 'M20.6 15.1A8.7 8.7 0 0 1 8.9 3.4 8.8 8.8 0 1 0 20.6 15.1Z' })
  ]);
  const sun = loginSymbol({ 'data-theme-sun': true, hidden: true, width: 21, height: 21, strokeWidth: 1.9 }, [
    h('circle', { cx: 12, cy: 12, r: 3.6 }),
    h('path', { d: 'M12 2.3v2.1M12 19.6v2.1M4.4 4.4l1.5 1.5M18.1 18.1l1.5 1.5M2.3 12h2.1M19.6 12h2.1M4.4 19.6l1.5-1.5M18.1 5.9l1.5-1.5' })
  ]);
  const openEye = loginSymbol({ 'data-eye-open': true, width: 18, height: 18, strokeWidth: 1.8 }, [
    h('path', { d: 'M2.5 12s3.45-5.75 9.5-5.75S21.5 12 21.5 12s-3.45 5.75-9.5 5.75S2.5 12 2.5 12Z' }),
    h('circle', { cx: 12, cy: 12, r: 2.75 })
  ]);
  const closedEye = loginSymbol({ 'data-eye-closed': true, hidden: true, width: 18, height: 18, strokeWidth: 1.8 }, [
    h('path', { d: 'M4.2 8.55C3.05 9.65 2.5 12 2.5 12s3.45 5.75 9.5 5.75c1.35 0 2.6-.28 3.7-.72M8.1 6.7A10.6 10.6 0 0 1 12 6.25c6.05 0 9.5 5.75 9.5 5.75a12 12 0 0 1-2.05 2.8' }),
    h('path', { d: 'M9.8 9.75a3.05 3.05 0 0 0 4.45 4.4M3.2 3.2l17.6 17.6' })
  ]);

  return h('div', { className: 'login-shell' },
    h('div', { className: 'login-batik-background', 'aria-hidden': 'true' }),
    h('button', {
      'data-theme-toggle': true,
      type: 'button',
      className: 'login-theme-toggle',
      title: 'Gunakan mode gelap',
      'aria-label': 'Gunakan mode gelap',
      'aria-pressed': 'false'
    }, moon, sun),
    h('main', { className: 'login-stage' },
      h('div', { className: 'login-stack' },
        h('section', { className: 'login-glass-card', 'aria-labelledby': 'login-title' },
          h('div', { className: 'login-brand' },
            h('div', { className: 'login-logo-shell' },
              h('img', { src: '/logo-puskesmas-32981.svg', alt: 'Logo Puskesmas Gumukmas', className: 'h-11 w-11 object-contain' })
            ),
            h('h1', { id: 'login-title', className: 'login-title' }, 'E-Posyandu'),
            h('p', { className: 'login-organization' }, 'UPTD Puskesmas Gumukmas'),
            h('div', { className: 'login-brand-rule', 'aria-hidden': 'true' }, h('span', null), h('span', null), h('span', null))
          ),
          h('form', { 'data-login-form': true, className: 'login-form' },
            h('label', { className: 'login-field' },
              h('span', null, 'Username'),
              h('input', {
                'data-username': true,
                required: true,
                type: 'text',
                autoComplete: 'username',
                autoCapitalize: 'none',
                spellCheck: false
              })
            ),
            h('div', { className: 'login-field' },
              h('label', { htmlFor: 'password' }, 'Kata Sandi'),
              h('div', { className: 'login-password-field' },
                h('input', { 'data-password': true, id: 'password', required: true, type: 'password', autoComplete: 'current-password' }),
                h('button', {
                  'data-toggle-password': true,
                  type: 'button',
                  title: 'Perlihatkan kata sandi',
                  'aria-label': 'Perlihatkan kata sandi',
                  className: 'login-password-toggle'
                }, openEye, closedEye)
              )
            ),
            h('div', { 'data-turnstile': true, className: 'login-turnstile' }),
            h('p', { 'data-error': true, hidden: true, role: 'alert', className: 'login-error' }),
            h('button', { 'data-submit': true, type: 'submit', className: 'login-submit' },
              h('span', { 'data-submit-label': true }, 'Masuk')
            )
          )
        )
      )
    ),
    h('footer', { className: 'login-footer' },
      h('p', null, '© 2026 UPTD Puskesmas Gumukmas Developed by Johandi Arifiansyach'),
      h('button', {
        'data-release-notes': true,
        type: 'button',
        className: 'app-version-button login-version-button',
        'aria-haspopup': 'dialog',
        title: 'Lihat apa yang baru'
      }, `E-Posyandu v${APP_VERSION}`)
    )
  );
}

export function mountLoginPage(container: HTMLElement, options: { onLogin: LoginHandler }): () => void {
  container.replaceChildren(loginView());

  const form = requiredElement<HTMLFormElement>(container, '[data-login-form]');
  const themeToggleButton = requiredElement<HTMLButtonElement>(container, '[data-theme-toggle]');
  const themeMoon = requiredElement<SVGSVGElement>(container, '[data-theme-moon]');
  const themeSun = requiredElement<SVGSVGElement>(container, '[data-theme-sun]');
  const usernameInput = requiredElement<HTMLInputElement>(container, '[data-username]');
  const passwordInput = requiredElement<HTMLInputElement>(container, '[data-password]');
  const togglePasswordButton = requiredElement<HTMLButtonElement>(container, '[data-toggle-password]');
  const openEye = requiredElement<SVGSVGElement>(container, '[data-eye-open]');
  const closedEye = requiredElement<SVGSVGElement>(container, '[data-eye-closed]');
  const turnstileContainer = requiredElement<HTMLElement>(container, '[data-turnstile]');
  const submitButton = requiredElement<HTMLButtonElement>(container, '[data-submit]');
  const submitLabel = requiredElement<HTMLElement>(container, '[data-submit-label]');
  const errorNotice = requiredElement<HTMLElement>(container, '[data-error]');
  const releaseNotesButton = requiredElement<HTMLButtonElement>(container, '[data-release-notes]');

  let active = true;
  let turnstileWidgetId: string | null = null;
  let turnstileToken = '';
  let passwordVisible = false;
  let colorScheme = getPreferredColorScheme();

  const setSubmitReady = () => {
    submitButton.disabled = Boolean(turnstileSiteKey && !turnstileToken);
    submitLabel.textContent = 'Masuk';
  };
  const showError = (message: string) => {
    errorNotice.textContent = message;
    errorNotice.hidden = false;
  };
  const clearError = () => {
    errorNotice.textContent = '';
    errorNotice.hidden = true;
  };
  const renderWidget = () => {
    if (!active || !turnstileSiteKey || !window.turnstile || turnstileWidgetId) return;
    turnstileWidgetId = window.turnstile.render(turnstileContainer, {
      sitekey: turnstileSiteKey,
      action: 'login',
      size: 'flexible',
      appearance: 'always',
      theme: colorScheme,
      callback: (token) => {
        turnstileToken = token;
        clearError();
        setSubmitReady();
      },
      'expired-callback': () => {
        turnstileToken = '';
        setSubmitReady();
      },
      'error-callback': () => {
        turnstileToken = '';
        setSubmitReady();
        showError('Verifikasi keamanan belum siap. Coba lagi.');
      }
    });
  };
  const handleScriptError = () => {
    showError('Verifikasi keamanan gagal dimuat. Periksa koneksi internet lalu muat ulang halaman.');
  };
  const resetTurnstile = () => {
    if (turnstileSiteKey) {
      turnstileToken = '';
      if (turnstileWidgetId) window.turnstile?.reset(turnstileWidgetId);
    }
    setSubmitReady();
  };
  const togglePasswordVisibility = () => {
    passwordVisible = !passwordVisible;
    passwordInput.type = passwordVisible ? 'text' : 'password';
    openEye.toggleAttribute('hidden', passwordVisible);
    closedEye.toggleAttribute('hidden', !passwordVisible);
    const label = passwordVisible ? 'Sembunyikan kata sandi' : 'Perlihatkan kata sandi';
    togglePasswordButton.title = label;
    togglePasswordButton.setAttribute('aria-label', label);
    passwordInput.focus({ preventScroll: true });
  };
  const syncThemeControl = (nextScheme: ColorScheme) => {
    const changed = colorScheme !== nextScheme;
    colorScheme = nextScheme;
    const darkMode = colorScheme === 'dark';
    themeMoon.toggleAttribute('hidden', darkMode);
    themeSun.toggleAttribute('hidden', !darkMode);
    const label = darkMode ? 'Gunakan mode terang' : 'Gunakan mode gelap';
    themeToggleButton.title = label;
    themeToggleButton.setAttribute('aria-label', label);
    themeToggleButton.setAttribute('aria-pressed', darkMode ? 'true' : 'false');

    if (changed && turnstileWidgetId) {
      window.turnstile?.remove(turnstileWidgetId);
      turnstileWidgetId = null;
      turnstileToken = '';
      setSubmitReady();
      window.requestAnimationFrame(renderWidget);
    }
  };
  const toggleColorScheme = () => {
    saveColorScheme(colorScheme === 'dark' ? 'light' : 'dark');
  };
  const handleSubmit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (turnstileSiteKey && !turnstileToken) {
      showError('Selesaikan verifikasi keamanan sebelum masuk.');
      return;
    }
    submitButton.disabled = true;
    submitLabel.textContent = 'Memproses...';
    clearError();
    try {
      await options.onLogin(usernameInput.value.trim(), passwordInput.value, turnstileToken || undefined);
    } catch (error) {
      console.error('Gagal masuk:', error);
      showError(error instanceof Error ? error.message : 'Tidak dapat masuk ke aplikasi.');
      resetTurnstile();
    }
  };

  turnstileContainer.hidden = !turnstileSiteKey;
  setSubmitReady();
  syncThemeControl(colorScheme);
  const unsubscribeTheme = subscribeColorScheme(syncThemeControl);
  themeToggleButton.addEventListener('click', toggleColorScheme);
  togglePasswordButton.addEventListener('click', togglePasswordVisibility);
  releaseNotesButton.addEventListener('click', openReleaseNotes);
  form.addEventListener('submit', handleSubmit);

  const existingScript = document.getElementById('cloudflare-turnstile') as HTMLScriptElement | null;
  const turnstileScript = existingScript || document.createElement('script');
  if (!existingScript && turnstileSiteKey) {
    turnstileScript.id = 'cloudflare-turnstile';
    turnstileScript.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    turnstileScript.async = true;
    turnstileScript.defer = true;
    document.head.append(turnstileScript);
  }
  if (turnstileSiteKey) {
    turnstileScript.addEventListener('load', renderWidget);
    turnstileScript.addEventListener('error', handleScriptError);
    renderWidget();
  }

  usernameInput.focus({ preventScroll: true });

  return () => {
    active = false;
    unsubscribeTheme();
    themeToggleButton.removeEventListener('click', toggleColorScheme);
    togglePasswordButton.removeEventListener('click', togglePasswordVisibility);
    releaseNotesButton.removeEventListener('click', openReleaseNotes);
    form.removeEventListener('submit', handleSubmit);
    turnstileScript.removeEventListener('load', renderWidget);
    turnstileScript.removeEventListener('error', handleScriptError);
    if (turnstileWidgetId) window.turnstile?.remove(turnstileWidgetId);
    turnstileWidgetId = null;
    closeReleaseNotes();
  };
}

export default mountLoginPage;
