import { createElement as h } from '../runtime/dom';
import type { MfaEnrollment, MfaStatus, SignInResult } from '../api/authApi';
import {
  getPreferredColorScheme,
  saveColorScheme,
  subscribeColorScheme,
  type ColorScheme
} from '../theme/colorScheme';

type MfaPageOptions = {
  initial: MfaStatus;
  onEnroll: () => Promise<MfaEnrollment>;
  onVerify: (code: string) => Promise<SignInResult>;
  onSuccess: (result: SignInResult) => Promise<void>;
  onCancel: () => Promise<void>;
};

function requiredElement<T extends Element>(container: ParentNode, selector: string): T {
  const element = container.querySelector<T>(selector);
  if (!element) throw new Error(`Elemen MFA tidak ditemukan: ${selector}`);
  return element;
}

function mfaView() {
  return h('div', { className: 'login-shell' },
    h('div', { className: 'login-batik-background', 'aria-hidden': 'true' }),
    h('button', {
      'data-mfa-theme': true,
      type: 'button',
      className: 'login-theme-toggle',
      'aria-label': 'Gunakan mode gelap'
    }, '◐'),
    h('main', { className: 'login-stage' },
      h('section', { className: 'login-glass-card mfa-card', 'aria-labelledby': 'mfa-title' },
        h('div', { className: 'login-brand' },
          h('div', { className: 'login-logo-shell' },
            h('img', { src: '/logo-puskesmas-32981.svg', alt: 'Logo Puskesmas Gumukmas' })
          ),
          h('h1', { id: 'mfa-title', className: 'mfa-title' }, 'Verifikasi Dua Langkah'),
          h('p', { 'data-mfa-description': true, className: 'mfa-description' },
            'Masukkan kode dari aplikasi autentikator.'
          )
        ),
        h('div', { 'data-mfa-loading': true, className: 'mfa-loading', role: 'status' },
          'Membuat kode autentikator…'
        ),
        h('section', { 'data-mfa-setup': true, className: 'mfa-setup', hidden: true },
          h('p', null, 'Pindai QR ini memakai Google Authenticator, Microsoft Authenticator, Authy, atau pengelola kata sandi yang mendukung TOTP.'),
          h('img', { 'data-mfa-qr': true, className: 'mfa-qr', alt: 'QR untuk menambahkan autentikator TOTP' }),
          h('p', { className: 'mfa-secret-label' }, 'Jika QR tidak dapat dipindai, masukkan kode ini:'),
          h('code', { 'data-mfa-secret': true, className: 'mfa-secret' }),
          h('p', { className: 'mfa-warning' }, 'Jangan memotret atau membagikan QR dan kode rahasia ini.')
        ),
        h('form', { 'data-mfa-form': true, className: 'login-form mfa-form' },
          h('label', { className: 'login-field' },
            h('span', null, 'Kode autentikator 6 digit'),
            h('input', {
              'data-mfa-code': true,
              type: 'text',
              inputMode: 'numeric',
              pattern: '[0-9]{6}',
              maxLength: 6,
              autoComplete: 'one-time-code',
              required: true,
              disabled: true
            })
          ),
          h('p', { 'data-mfa-error': true, hidden: true, role: 'alert', className: 'login-error' }),
          h('button', { 'data-mfa-submit': true, type: 'submit', className: 'login-submit', disabled: true },
            'Verifikasi'
          ),
          h('button', { 'data-mfa-cancel': true, type: 'button', className: 'mfa-cancel' },
            'Batalkan dan keluar'
          )
        )
      )
    )
  );
}

function safeQrSource(value: string): { src: string; revoke?: () => void } {
  if (value.startsWith('data:image/svg+xml')) return { src: value };
  if (!value.trimStart().startsWith('<svg')) throw new Error('QR autentikator tidak valid.');
  const url = URL.createObjectURL(new Blob([value], { type: 'image/svg+xml' }));
  return { src: url, revoke: () => URL.revokeObjectURL(url) };
}

export function mountMfaPage(container: HTMLElement, options: MfaPageOptions): () => void {
  container.replaceChildren(mfaView());
  const description = requiredElement<HTMLElement>(container, '[data-mfa-description]');
  const loading = requiredElement<HTMLElement>(container, '[data-mfa-loading]');
  const setup = requiredElement<HTMLElement>(container, '[data-mfa-setup]');
  const qr = requiredElement<HTMLImageElement>(container, '[data-mfa-qr]');
  const secret = requiredElement<HTMLElement>(container, '[data-mfa-secret]');
  const form = requiredElement<HTMLFormElement>(container, '[data-mfa-form]');
  const code = requiredElement<HTMLInputElement>(container, '[data-mfa-code]');
  const submit = requiredElement<HTMLButtonElement>(container, '[data-mfa-submit]');
  const cancel = requiredElement<HTMLButtonElement>(container, '[data-mfa-cancel]');
  const errorNotice = requiredElement<HTMLElement>(container, '[data-mfa-error]');
  const theme = requiredElement<HTMLButtonElement>(container, '[data-mfa-theme]');
  let active = true;
  let busy = false;
  let revokeQr: (() => void) | undefined;
  let colorScheme: ColorScheme = getPreferredColorScheme();

  const showError = (message: string) => {
    errorNotice.textContent = message;
    errorNotice.hidden = false;
  };
  const setReady = (ready: boolean) => {
    loading.hidden = ready;
    code.disabled = !ready;
    submit.disabled = !ready;
    if (ready) code.focus({ preventScroll: true });
  };
  const syncTheme = (next: ColorScheme) => {
    colorScheme = next;
    theme.setAttribute('aria-label', next === 'dark' ? 'Gunakan mode terang' : 'Gunakan mode gelap');
  };
  const handleTheme = () => saveColorScheme(colorScheme === 'dark' ? 'light' : 'dark');
  const begin = async () => {
    try {
      if (options.initial.state === 'challenge') {
        loading.textContent = '';
        description.textContent = 'Buka aplikasi autentikator Anda, lalu masukkan kode 6 digit yang sedang tampil.';
        setReady(true);
        return;
      }
      const enrollment = await options.onEnroll();
      if (!active) return;
      if (enrollment.state === 'challenge' || enrollment.state === 'verified') {
        description.textContent = 'Buka aplikasi autentikator Anda, lalu masukkan kode 6 digit yang sedang tampil.';
        setReady(true);
        return;
      }
      if (!enrollment.qrCode || !enrollment.secret) throw new Error('Data pendaftaran autentikator belum lengkap.');
      const source = safeQrSource(enrollment.qrCode);
      qr.src = source.src;
      revokeQr = source.revoke;
      secret.textContent = enrollment.secret.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();
      description.textContent = 'Daftarkan perangkat autentikator sebelum melanjutkan.';
      setup.hidden = false;
      setReady(true);
    } catch (error) {
      if (!active) return;
      loading.hidden = true;
      showError(error instanceof Error ? error.message : 'MFA belum dapat disiapkan.');
    }
  };
  const handleSubmit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy) return;
    const normalizedCode = code.value.replace(/\D/g, '');
    if (normalizedCode.length !== 6) {
      showError('Masukkan tepat 6 digit kode autentikator.');
      return;
    }
    busy = true;
    submit.disabled = true;
    cancel.disabled = true;
    errorNotice.hidden = true;
    try {
      const result = await options.onVerify(normalizedCode);
      if (active) await options.onSuccess(result);
    } catch (error) {
      if (!active) return;
      showError(error instanceof Error ? error.message : 'Kode belum dapat diverifikasi.');
      code.value = '';
      code.focus({ preventScroll: true });
      busy = false;
      submit.disabled = false;
      cancel.disabled = false;
    }
  };
  const handleCancel = async () => {
    if (busy) return;
    busy = true;
    cancel.disabled = true;
    try {
      await options.onCancel();
    } catch (error) {
      busy = false;
      cancel.disabled = false;
      showError(error instanceof Error ? error.message : 'Sesi belum dapat dibatalkan.');
    }
  };

  const unsubscribeTheme = subscribeColorScheme(syncTheme);
  syncTheme(colorScheme);
  theme.addEventListener('click', handleTheme);
  form.addEventListener('submit', handleSubmit);
  cancel.addEventListener('click', handleCancel);
  void begin();

  return () => {
    active = false;
    unsubscribeTheme();
    theme.removeEventListener('click', handleTheme);
    form.removeEventListener('submit', handleSubmit);
    cancel.removeEventListener('click', handleCancel);
    revokeQr?.();
  };
}

export default mountMfaPage;
