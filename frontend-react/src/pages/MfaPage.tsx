import { type FormEvent, useEffect, useMemo, useState } from 'react';
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
import {
  completeWebAuthnAuthentication,
  completeWebAuthnRegistration
} from '../security/webauthn';

export type AuthenticatedResult = {
  profile: AccessProfile | null;
  recoveryCodes: string[];
};

export type MfaPageProps = {
  auth: Auth;
  pending: MfaPendingSignIn;
  onAuthenticated: (result: AuthenticatedResult) => Promise<void>;
  onCancel: () => Promise<void>;
};

type Enrollment = {
  id: string;
  totp?: {
    qr_code?: string;
    secret?: string;
  };
};

type View = 'choice' | 'totp' | 'recovery' | 'passkey' | 'codes';

function factorOfType(factors: MfaFactor[], type: MfaFactor['type']) {
  return factors.find((factor) => factor.type === type);
}

function MfaButton({
  label,
  onClick,
  secondary = false,
  disabled = false
}: {
  label: string;
  onClick: () => void;
  secondary?: boolean;
  disabled?: boolean;
}) {
  return <button
    type="button"
    className={secondary ? 'login-submit admin-mfa-secondary' : 'login-submit'}
    onClick={onClick}
    disabled={disabled}
  >{label}</button>;
}

function MfaShell({ children }: { children: React.ReactNode }) {
  return <div className="login-shell">
    <div className="login-batik-background" aria-hidden="true" />
    <main className="login-stage">
      <div className="login-stack">
        <section className="login-glass-card admin-mfa-card" aria-labelledby="react-mfa-title">
          <div className="login-brand">
            <div className="login-logo-shell">
              <img src="/logo-puskesmas-32981.svg" alt="Logo Puskesmas Gumukmas" className="h-11 w-11 object-contain" width={44} height={44} loading="eager" decoding="async" />
            </div>
            <h1 id="react-mfa-title" className="login-title">Verifikasi Administrator</h1>
            <p className="login-organization">Akses penuh memerlukan faktor keamanan kedua</p>
            <div className="login-brand-rule" aria-hidden="true"><span /><span /><span /></div>
          </div>
          {children}
        </section>
      </div>
    </main>
    <footer className="login-footer"><p>E-Posyandu v{APP_VERSION}</p></footer>
  </div>;
}

export default function MfaPage({ auth, pending, onAuthenticated, onCancel }: MfaPageProps) {
  const [view, setView] = useState<View>('choice');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [factorId, setFactorId] = useState('');
  const [code, setCode] = useState('');
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [authenticatedResult, setAuthenticatedResult] = useState<AuthenticatedResult | null>(null);
  const passkey = factorOfType(pending.factors, 'webauthn');
  const totp = factorOfType(pending.factors, 'totp');

  const qrUrl = useMemo(() => {
    const sourceValue = enrollment?.totp?.qr_code;
    if (!sourceValue) return null;
    const source = String(sourceValue).replace(/^data:image\/svg\+xml;(?:utf-8|utf8),/i, '');
    return URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }));
  }, [enrollment]);

  useEffect(() => () => {
    if (qrUrl) URL.revokeObjectURL(qrUrl);
  }, [qrUrl]);

  const finish = async (result: AuthenticatedResult) => {
    if (result.recoveryCodes.length > 0) {
      setAuthenticatedResult(result);
      setView('codes');
      return;
    }
    await onAuthenticated(result);
  };

  const runPasskey = async (factor?: MfaFactor) => {
    if (busy) return;
    if (!factor && totp) {
      setMessage('Masuk dengan authenticator TOTP terlebih dahulu. Setelah masuk, daftarkan passkey dari Administrasi Backend.');
      setView('choice');
      return;
    }
    setBusy(true);
    setMessage('');
    setView('passkey');
    try {
      const result = factor
        ? await (async () => {
            const challenge = await startPasskeyAuthentication();
            const ceremony = await completeWebAuthnAuthentication(challenge);
            return verifyPasskeyAuthentication(auth, ceremony.challengeId, ceremony.credential);
          })()
        : await (async () => {
            const challenge = await startPasskeyRegistration();
            const ceremony = await completeWebAuthnRegistration(challenge);
            return verifyPasskeyRegistration(auth, ceremony.challengeId, ceremony.credential);
          })();
      if (!factor && 'requiresAuthentication' in result && result.requiresAuthentication) {
        const challenge = await startPasskeyAuthentication();
        const ceremony = await completeWebAuthnAuthentication(challenge);
        const authenticated = await verifyPasskeyAuthentication(auth, ceremony.challengeId, ceremony.credential);
        await finish({
          profile: authenticated.profile,
          recoveryCodes: result.recoveryCodes.length > 0 ? result.recoveryCodes : authenticated.recoveryCodes
        });
      } else {
        await finish({ profile: result.profile, recoveryCodes: result.recoveryCodes });
      }
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Passkey tidak dapat diverifikasi.');
      setView('choice');
    } finally {
      setBusy(false);
    }
  };

  const verifyTotp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !factorId || !/^[0-9]{6}$/.test(code.trim())) return;
    setBusy(true);
    setMessage('');
    try {
      const challenge = await challengeMfaFactor(factorId, 'totp');
      const result = await verifyMfaFactor(auth, {
        factorType: 'totp',
        factorId,
        challengeId: challenge.id,
        code: code.trim()
      });
      await finish({ profile: result.profile, recoveryCodes: result.recoveryCodes });
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Kode tidak valid.');
    } finally {
      setBusy(false);
    }
  };

  const setupTotp = async () => {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const nextEnrollment = await enrollMfaFactor('totp') as Enrollment;
      setEnrollment(nextEnrollment);
      setFactorId(nextEnrollment.id);
      setCode('');
      setView('totp');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Authenticator belum dapat disiapkan.');
      setView('choice');
    } finally {
      setBusy(false);
    }
  };

  const verifyRecovery = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !code.trim()) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await verifyMfaFactor(auth, { factorType: 'recovery', code: code.trim() });
      await finish({ profile: result.profile, recoveryCodes: result.recoveryCodes });
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Kode pemulihan tidak valid.');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await signOut(auth).catch(() => undefined);
      await onCancel();
    } finally {
      setBusy(false);
    }
  };

  const backToChoice = () => {
    if (busy) return;
    setMessage('');
    setCode('');
    setEnrollment(null);
    setView('choice');
  };

  if (view === 'codes' && authenticatedResult) {
    const codes = authenticatedResult.recoveryCodes.join('\n');
    return <MfaShell><div className="login-form admin-mfa-panel">
      <p className="admin-mfa-help">Simpan kode berikut secara offline. Setiap kode hanya dapat digunakan satu kali dan tidak akan ditampilkan lagi.</p>
      <pre className="admin-mfa-codes">{codes}</pre>
      {message ? <p role="alert" className="login-error">{message}</p> : null}
      <MfaButton label="Salin semua kode" secondary onClick={() => {
        void navigator.clipboard.writeText(codes).then(() => setMessage('Kode disalin.')).catch(() => setMessage('Kode tidak dapat disalin otomatis.'));
      }} />
      <MfaButton label="Saya sudah menyimpan, lanjut" disabled={busy} onClick={() => void onAuthenticated(authenticatedResult)} />
    </div></MfaShell>;
  }

  if (view === 'passkey') {
    return <MfaShell><div className="login-form admin-mfa-panel">
      <p className="admin-mfa-help">{passkey ? 'Konfirmasi passkey pada perangkat Anda…' : 'Daftarkan passkey pada perangkat Anda…'}</p>
      {message ? <p role="alert" className="login-error">{message}</p> : null}
      <MfaButton label="Kembali" secondary disabled={busy} onClick={backToChoice} />
    </div></MfaShell>;
  }

  if (view === 'totp') {
    return <MfaShell><form className="login-form admin-mfa-panel" onSubmit={verifyTotp}>
      {qrUrl ? <img className="admin-mfa-qr" alt="QR setup authenticator" src={qrUrl} loading="lazy" decoding="async" /> : null}
      {enrollment?.totp?.secret ? <div className="admin-mfa-secret"><span>Kunci manual</span><code>{enrollment.totp.secret}</code></div> : null}
      <p className="admin-mfa-help">{enrollment ? 'Pindai QR dengan aplikasi authenticator, lalu masukkan kode 6 angka.' : 'Masukkan kode 6 angka dari aplikasi authenticator.'}</p>
      <label className="login-field"><span>Kode authenticator</span><input required type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} placeholder="000000" value={code} onChange={(event) => setCode(event.target.value)} autoFocus /></label>
      {message ? <p role="alert" className="login-error">{message}</p> : null}
      <button type="submit" className="login-submit" disabled={busy}>Verifikasi</button>
      <MfaButton label="Kembali" secondary disabled={busy} onClick={backToChoice} />
    </form></MfaShell>;
  }

  if (view === 'recovery') {
    return <MfaShell><form className="login-form admin-mfa-panel" onSubmit={verifyRecovery}>
      <p className="admin-mfa-help">Gunakan satu kode pemulihan yang belum pernah digunakan.</p>
      <label className="login-field"><span>Kode pemulihan</span><input required type="text" autoComplete="off" autoCapitalize="characters" placeholder="XXXX-XXXX-XXXX-XXXX" value={code} onChange={(event) => setCode(event.target.value)} autoFocus /></label>
      {message ? <p role="alert" className="login-error">{message}</p> : null}
      <button type="submit" className="login-submit" disabled={busy}>Gunakan kode</button>
      <MfaButton label="Kembali" secondary disabled={busy} onClick={backToChoice} />
    </form></MfaShell>;
  }

  return <MfaShell><div className="login-form admin-mfa-panel">
      <p className="admin-mfa-help">{pending.setupRequired ? 'Daftarkan passkey sebagai metode utama. Authenticator TOTP tersedia sebagai cadangan.' : 'Pilih metode verifikasi yang sudah terdaftar.'}</p>
      {message ? <p role="alert" className="login-error">{message}</p> : null}
      <MfaButton label={passkey ? 'Gunakan passkey' : 'Daftarkan passkey'} disabled={busy} onClick={() => void runPasskey(passkey)} />
      <MfaButton label={totp ? 'Gunakan authenticator (TOTP)' : 'Siapkan authenticator (TOTP)'} secondary disabled={busy} onClick={() => {
      if (totp) {
        setFactorId(totp.id);
        setEnrollment(null);
        setCode('');
        setMessage('');
        setView('totp');
      } else void setupTotp();
    }} />
    {pending.setupRequired ? null : <MfaButton label="Gunakan kode pemulihan" secondary disabled={busy} onClick={() => { setCode(''); setMessage(''); setView('recovery'); }} />}
    <MfaButton label="Batalkan dan keluar" secondary disabled={busy} onClick={() => void cancel()} />
  </div></MfaShell>;
}
