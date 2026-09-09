import { completeAdminInvitation, type SignInResult } from '../api/authApi';
import { APP_VERSION } from '../config/app';
import { createElement as h } from '../runtime/dom';

type Options = {
  accessToken: string;
  refreshToken: string;
  onComplete: (result: SignInResult) => Promise<void>;
  onCancel: () => Promise<void>;
};

export function mountAdminInvitePage(container: HTMLElement, options: Options): () => void {
  let active = true;
  const password = h('input', {
    required: true,
    type: 'password',
    autoComplete: 'new-password',
    minLength: 14
  }) as HTMLInputElement;
  const confirmation = h('input', {
    required: true,
    type: 'password',
    autoComplete: 'new-password',
    minLength: 14
  }) as HTMLInputElement;
  const error = h('p', { hidden: true, role: 'alert', className: 'login-error' }) as HTMLElement;
  const submit = h('button', { type: 'submit', className: 'login-submit' }, 'Aktifkan akun') as HTMLButtonElement;
  const form = h('form', { className: 'login-form admin-mfa-panel' },
    h('p', { className: 'admin-mfa-help' }, 'Buat kata sandi unik untuk akun E-Posyandu Anda. Administrator akan melanjutkan ke verifikasi dua langkah.'),
    h('label', { className: 'login-field' }, h('span', null, 'Kata sandi baru'), password),
    h('label', { className: 'login-field' }, h('span', null, 'Ulangi kata sandi'), confirmation),
    h('p', { className: 'admin-mfa-help' }, 'Minimal 14 karakter dengan huruf besar, huruf kecil, angka, dan simbol.'),
    error,
    submit,
    h('button', {
      type: 'button',
      className: 'login-submit admin-mfa-secondary',
      onClick: () => { void options.onCancel(); }
    }, 'Batalkan')
  ) as HTMLFormElement;

  container.replaceChildren(h('div', { className: 'login-shell' },
    h('div', { className: 'login-batik-background', 'aria-hidden': 'true' }),
    h('main', { className: 'login-stage' }, h('div', { className: 'login-stack' },
      h('section', { className: 'login-glass-card admin-mfa-card', 'aria-labelledby': 'invite-title' },
        h('div', { className: 'login-brand' },
          h('div', { className: 'login-logo-shell' },
            h('img', { src: '/logo-puskesmas-32981.svg', alt: 'Logo Puskesmas Gumukmas', className: 'h-11 w-11 object-contain' })
          ),
          h('h1', { id: 'invite-title', className: 'login-title' }, 'Aktivasi Akun'),
          h('p', { className: 'login-organization' }, 'E-Posyandu Puskesmas Gumukmas'),
          h('div', { className: 'login-brand-rule', 'aria-hidden': 'true' }, h('span', null), h('span', null), h('span', null))
        ),
        form
      )
    )),
    h('footer', { className: 'login-footer' }, h('p', null, `E-Posyandu v${APP_VERSION}`))
  ) as Node);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    if (password.value !== confirmation.value) {
      error.textContent = 'Konfirmasi kata sandi tidak sama.';
      error.hidden = false;
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Menyimpan…';
    try {
      const result = await completeAdminInvitation(
        options.accessToken,
        options.refreshToken,
        password.value
      );
      password.value = '';
      confirmation.value = '';
      if (active) await options.onComplete(result);
    } catch (value) {
      error.textContent = value instanceof Error ? value.message : 'Undangan tidak dapat diaktifkan.';
      error.hidden = false;
      submit.disabled = false;
      submit.textContent = 'Aktifkan akun';
    }
  });
  password.focus({ preventScroll: true });

  return () => {
    active = false;
    password.value = '';
    confirmation.value = '';
  };
}

export default mountAdminInvitePage;
