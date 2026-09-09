import {
  challengeMfaFactor,
  enrollMfaFactor,
  signOut,
  startPasskeyAuthentication,
  startPasskeyRegistration,
  verifyMfaFactor,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
  type AccessProfile,
  type Auth,
  type MfaFactor,
  type MfaPendingSignIn
} from '../api/authApi';
import { APP_VERSION } from '../config/app';
import { createElement as h } from '../runtime/dom';
import {
  completeWebAuthnAuthentication,
  completeWebAuthnRegistration
} from '../security/webauthn';

type AuthenticatedResult = {
  profile: AccessProfile | null;
  recoveryCodes: string[];
};

type Options = {
  auth: Auth;
  pending: MfaPendingSignIn;
  onAuthenticated: (result: AuthenticatedResult) => Promise<void>;
  onCancel: () => Promise<void>;
};

function shell(content: Node) {
  return h('div', { className: 'login-shell' },
    h('div', { className: 'login-batik-background', 'aria-hidden': 'true' }),
    h('main', { className: 'login-stage' },
      h('div', { className: 'login-stack' },
        h('section', { className: 'login-glass-card admin-mfa-card', 'aria-labelledby': 'mfa-title' },
          h('div', { className: 'login-brand' },
            h('div', { className: 'login-logo-shell' },
              h('img', { src: '/logo-puskesmas-32981.svg', alt: 'Logo Puskesmas Gumukmas', className: 'h-11 w-11 object-contain' })
            ),
            h('h1', { id: 'mfa-title', className: 'login-title' }, 'Verifikasi Administrator'),
            h('p', { className: 'login-organization' }, 'Akses penuh memerlukan faktor keamanan kedua'),
            h('div', { className: 'login-brand-rule', 'aria-hidden': 'true' }, h('span', null), h('span', null), h('span', null))
          ),
          content
        )
      )
    ),
    h('footer', { className: 'login-footer' }, h('p', null, `E-Posyandu v${APP_VERSION}`))
  );
}

function button(label: string, onClick: () => void, secondary = false): HTMLButtonElement {
  return h('button', {
    type: 'button',
    className: secondary ? 'login-submit admin-mfa-secondary' : 'login-submit',
    onClick
  }, label) as HTMLButtonElement;
}

function factorOfType(factors: MfaFactor[], type: MfaFactor['type']): MfaFactor | undefined {
  return factors.find((factor) => factor.type === type);
}

export function mountMfaPage(container: HTMLElement, options: Options): () => void {
  let active = true;
  let busy = false;
  const objectUrls = new Set<string>();

  const show = (content: Node) => {
    if (active) container.replaceChildren(shell(content) as Node);
  };
  const errorText = (message: string) => h('p', { role: 'alert', className: 'login-error' }, message) as HTMLElement;
  const setBusy = (value: boolean) => { busy = value; };

  const finish = async (result: AuthenticatedResult) => {
    if (result.recoveryCodes.length > 0) {
      showRecoveryCodes(result);
      return;
    }
    await options.onAuthenticated(result);
  };

  const runPasskey = async (factor?: MfaFactor) => {
    if (busy) return;
    const totp = factorOfType(options.pending.factors, 'totp');
    if (!factor && totp) {
      renderChoice('Masuk dengan authenticator TOTP terlebih dahulu. Setelah masuk, daftarkan passkey dari Administrasi Backend.');
      return;
    }
    setBusy(true);
    show(h('div', { className: 'login-form admin-mfa-panel' },
      h('p', { className: 'admin-mfa-help' }, factor
        ? 'Konfirmasi passkey pada perangkat Anda…'
        : 'Daftarkan passkey pada perangkat Anda…')
    ) as Node);
    try {
      const result = factor
        ? await (async () => {
            const challenge = await startPasskeyAuthentication();
            const ceremony = await completeWebAuthnAuthentication(challenge);
            return verifyPasskeyAuthentication(options.auth, ceremony.challengeId, ceremony.credential);
          })()
        : await (async () => {
            const challenge = await startPasskeyRegistration();
            const ceremony = await completeWebAuthnRegistration(challenge);
            return verifyPasskeyRegistration(options.auth, ceremony.challengeId, ceremony.credential);
          })();
      if (!factor && 'requiresAuthentication' in result && result.requiresAuthentication) {
        // Registering the first passkey creates a credential but does not
        // itself produce an AAL2 session. Immediately authenticate the newly
        // registered credential so the administrator can enter the app while
        // keeping the recovery codes generated during setup visible.
        const challenge = await startPasskeyAuthentication();
        const ceremony = await completeWebAuthnAuthentication(challenge);
        const authenticated = await verifyPasskeyAuthentication(
          options.auth,
          ceremony.challengeId,
          ceremony.credential
        );
        await finish({
          profile: authenticated.profile,
          recoveryCodes: result.recoveryCodes.length > 0
            ? result.recoveryCodes
            : authenticated.recoveryCodes
        });
      } else {
        await finish({ profile: result.profile, recoveryCodes: result.recoveryCodes });
      }
    } catch (error) {
      renderChoice(error instanceof Error ? error.message : 'Passkey tidak dapat diverifikasi.');
    } finally {
      setBusy(false);
    }
  };

  const verifyTotp = async (factorId: string, code: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const challenge = await challengeMfaFactor(factorId, 'totp');
      const result = await verifyMfaFactor(options.auth, {
        factorType: 'totp',
        factorId,
        challengeId: challenge.id,
        code
      });
      await finish({ profile: result.profile, recoveryCodes: result.recoveryCodes });
    } catch (error) {
      renderTotp(factorId, undefined, error instanceof Error ? error.message : 'Kode tidak valid.');
    } finally {
      setBusy(false);
    }
  };

  const renderTotp = (factorId: string, enrollment?: any, message?: string) => {
    let qrImage: HTMLImageElement | null = null;
    if (enrollment?.totp?.qr_code) {
      qrImage = h('img', {
        className: 'admin-mfa-qr',
        alt: 'QR setup authenticator'
      }) as HTMLImageElement;
      const source = String(enrollment.totp.qr_code).replace(/^data:image\/svg\+xml;(?:utf-8|utf8),/i, '');
      const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }));
      objectUrls.add(url);
      qrImage.src = url;
    }
    const input = h('input', {
      required: true,
      type: 'text',
      inputMode: 'numeric',
      autoComplete: 'one-time-code',
      pattern: '[0-9]{6}',
      minLength: 6,
      maxLength: 6,
      placeholder: '000000'
    }) as HTMLInputElement;
    const form = h('form', { className: 'login-form admin-mfa-panel' },
      qrImage,
      enrollment?.totp?.secret
        ? h('div', { className: 'admin-mfa-secret' },
            h('span', null, 'Kunci manual'),
            h('code', null, enrollment.totp.secret)
          )
        : null,
      h('p', { className: 'admin-mfa-help' }, enrollment
        ? 'Pindai QR dengan aplikasi authenticator, lalu masukkan kode 6 angka.'
        : 'Masukkan kode 6 angka dari aplikasi authenticator.'),
      h('label', { className: 'login-field' }, h('span', null, 'Kode authenticator'), input),
      message ? errorText(message) : null,
      h('button', { type: 'submit', className: 'login-submit' }, 'Verifikasi'),
      button('Kembali', () => renderChoice(), true)
    ) as HTMLFormElement;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (/^[0-9]{6}$/.test(input.value.trim())) void verifyTotp(factorId, input.value.trim());
    });
    show(form);
    window.setTimeout(() => input.focus({ preventScroll: true }), 0);
  };

  const setupTotp = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const factor = await enrollMfaFactor('totp');
      renderTotp(factor.id, factor);
    } catch (error) {
      renderChoice(error instanceof Error ? error.message : 'Authenticator belum dapat disiapkan.');
    } finally {
      setBusy(false);
    }
  };

  const renderRecovery = (message?: string) => {
    const input = h('input', {
      required: true,
      type: 'text',
      autoComplete: 'off',
      autoCapitalize: 'characters',
      placeholder: 'XXXX-XXXX-XXXX-XXXX'
    }) as HTMLInputElement;
    const form = h('form', { className: 'login-form admin-mfa-panel' },
      h('p', { className: 'admin-mfa-help' }, 'Gunakan satu kode pemulihan yang belum pernah digunakan.'),
      h('label', { className: 'login-field' }, h('span', null, 'Kode pemulihan'), input),
      message ? errorText(message) : null,
      h('button', { type: 'submit', className: 'login-submit' }, 'Gunakan kode'),
      button('Kembali', () => renderChoice(), true)
    ) as HTMLFormElement;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy) return;
      setBusy(true);
      try {
        const result = await verifyMfaFactor(options.auth, {
          factorType: 'recovery',
          code: input.value.trim()
        });
        await finish({ profile: result.profile, recoveryCodes: result.recoveryCodes });
      } catch (error) {
        renderRecovery(error instanceof Error ? error.message : 'Kode pemulihan tidak valid.');
      } finally {
        setBusy(false);
      }
    });
    show(form);
    window.setTimeout(() => input.focus({ preventScroll: true }), 0);
  };

  const showRecoveryCodes = (result: AuthenticatedResult) => {
    const codes = result.recoveryCodes.join('\n');
    const notice = h('p', { className: 'admin-mfa-copy-notice', hidden: true }, 'Kode disalin.') as HTMLElement;
    show(h('div', { className: 'login-form admin-mfa-panel' },
      h('p', { className: 'admin-mfa-help' }, 'Simpan kode berikut secara offline. Setiap kode hanya dapat digunakan satu kali dan tidak akan ditampilkan lagi.'),
      h('pre', { className: 'admin-mfa-codes' }, codes),
      notice,
      button('Salin semua kode', () => {
        void navigator.clipboard.writeText(codes).then(() => { notice.hidden = false; });
      }, true),
      button('Saya sudah menyimpan, lanjut', () => { void options.onAuthenticated(result); })
    ) as Node);
  };

  const renderChoice = (message?: string) => {
    const passkey = factorOfType(options.pending.factors, 'webauthn');
    const totp = factorOfType(options.pending.factors, 'totp');
    show(h('div', { className: 'login-form admin-mfa-panel' },
      h('p', { className: 'admin-mfa-help' }, options.pending.setupRequired
        ? 'Daftarkan passkey sebagai metode utama. Authenticator TOTP tersedia sebagai cadangan.'
        : 'Pilih metode verifikasi yang sudah terdaftar.'),
      message ? errorText(message) : null,
      button(passkey ? 'Gunakan passkey' : 'Daftarkan passkey', () => { void runPasskey(passkey); }),
      passkey
        ? button('Daftarkan passkey baru', () => { void runPasskey(); }, true)
        : null,
      button(totp ? 'Gunakan authenticator (TOTP)' : 'Siapkan authenticator (TOTP)', () => {
        if (totp) renderTotp(totp.id);
        else void setupTotp();
      }, true),
      options.pending.setupRequired ? null : button('Gunakan kode pemulihan', () => renderRecovery(), true),
      button('Batalkan dan keluar', () => {
        void signOut(options.auth).catch(() => undefined).then(options.onCancel);
      }, true)
    ) as Node);
  };

  renderChoice();
  return () => {
    active = false;
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.clear();
  };
}

export default mountMfaPage;
