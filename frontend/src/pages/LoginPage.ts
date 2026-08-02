import { APP_VERSION } from '../config/app';
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

function loginTemplate() {
  return `
    <div class="login-shell">
      <div class="login-batik-background" aria-hidden="true"></div>
      <button data-theme-toggle type="button" class="login-theme-toggle" title="Gunakan mode gelap" aria-label="Gunakan mode gelap" aria-pressed="false">
        <svg data-theme-moon class="login-symbol" xmlns="http://www.w3.org/2000/svg" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M20.6 15.1A8.7 8.7 0 0 1 8.9 3.4 8.8 8.8 0 1 0 20.6 15.1Z"></path>
        </svg>
        <svg data-theme-sun class="login-symbol" hidden xmlns="http://www.w3.org/2000/svg" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3.6"></circle>
          <path d="M12 2.3v2.1M12 19.6v2.1M4.4 4.4l1.5 1.5M18.1 18.1l1.5 1.5M2.3 12h2.1M19.6 12h2.1M4.4 19.6l1.5-1.5M18.1 5.9l1.5-1.5"></path>
        </svg>
      </button>
      <main class="login-stage">
        <div class="login-stack">
          <section class="login-glass-card" aria-labelledby="login-title">
            <div class="login-brand">
              <div class="login-logo-shell">
                <img src="/logo-puskesmas-32981.svg" alt="Logo Puskesmas Gumukmas" class="h-11 w-11 object-contain" />
              </div>
              <h1 id="login-title" class="login-title">E-Posyandu</h1>
              <p class="login-organization">UPTD Puskesmas Gumukmas</p>
              <div class="login-brand-rule" aria-hidden="true">
                <span></span><span></span><span></span>
              </div>
            </div>
            <form data-login-form class="login-form">
              <label class="login-field">
                <span>Username</span>
                <input data-username required type="text" autocomplete="username" autocapitalize="none" spellcheck="false" />
              </label>
              <div class="login-field">
                <label for="password">Kata Sandi</label>
                <div class="login-password-field">
                  <input data-password id="password" required type="password" autocomplete="current-password" />
                  <button data-toggle-password type="button" title="Perlihatkan kata sandi" aria-label="Perlihatkan kata sandi" class="login-password-toggle">
                    <svg data-eye-open class="login-symbol" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M2.5 12s3.45-5.75 9.5-5.75S21.5 12 21.5 12s-3.45 5.75-9.5 5.75S2.5 12 2.5 12Z"></path>
                      <circle cx="12" cy="12" r="2.75"></circle>
                    </svg>
                    <svg data-eye-closed class="login-symbol" hidden xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M4.2 8.55C3.05 9.65 2.5 12 2.5 12s3.45 5.75 9.5 5.75c1.35 0 2.6-.28 3.7-.72M8.1 6.7A10.6 10.6 0 0 1 12 6.25c6.05 0 9.5 5.75 9.5 5.75a12 12 0 0 1-2.05 2.8"></path>
                      <path d="M9.8 9.75a3.05 3.05 0 0 0 4.45 4.4M3.2 3.2l17.6 17.6"></path>
                    </svg>
                  </button>
                </div>
              </div>
              <div data-turnstile class="login-turnstile"></div>
              <p data-error hidden role="alert" class="login-error"></p>
              <button data-submit type="submit" class="login-submit">
                <span data-submit-label>Masuk</span>
              </button>
            </form>
          </section>
        </div>
      </main>
      <footer class="login-footer">
        <p>&copy; 2026 UPTD Puskesmas Gumukmas Developed by Johandi Arifiansyach</p>
        <button data-release-notes type="button" class="app-version-button login-version-button" aria-haspopup="dialog" title="Lihat apa yang baru">
          E-Posyandu v${APP_VERSION}
        </button>
      </footer>
    </div>
  `;
}

export function mountLoginPage(container: HTMLElement, options: { onLogin: LoginHandler }): () => void {
  container.innerHTML = loginTemplate();

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
