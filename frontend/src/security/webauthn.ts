function decodeBase64Url(value: string): ArrayBuffer {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(window.atob(base64), (character) => character.charCodeAt(0));
  return bytes.buffer;
}

function encodeBase64Url(value: ArrayBuffer | null): string | undefined {
  if (!value) return undefined;
  const bytes = new Uint8Array(value);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function creationOptions(options: any): PublicKeyCredentialCreationOptions {
  const parser = (window.PublicKeyCredential as any)?.parseCreationOptionsFromJSON;
  if (typeof parser === 'function') return parser(options);
  return {
    ...options,
    challenge: decodeBase64Url(options.challenge),
    user: {
      ...options.user,
      name: options.user?.name || 'Administrator',
      displayName: options.user?.displayName || 'Administrator',
      id: decodeBase64Url(options.user.id)
    },
    excludeCredentials: (options.excludeCredentials || []).map((credential: any) => ({
      ...credential,
      id: decodeBase64Url(credential.id)
    }))
  };
}

function requestOptions(options: any): PublicKeyCredentialRequestOptions {
  const parser = (window.PublicKeyCredential as any)?.parseRequestOptionsFromJSON;
  if (typeof parser === 'function') return parser(options);
  return {
    ...options,
    challenge: decodeBase64Url(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((credential: any) => ({
      ...credential,
      id: decodeBase64Url(credential.id)
    }))
  };
}

function serializeCredential(credential: PublicKeyCredential, operation: 'create' | 'request'): unknown {
  if (typeof (credential as any).toJSON === 'function') return (credential as any).toJSON();
  const base = {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    type: 'public-key',
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: (credential as any).authenticatorAttachment || undefined
  };
  if (operation === 'create') {
    const response = credential.response as AuthenticatorAttestationResponse;
    return {
      ...base,
      response: {
        attestationObject: encodeBase64Url(response.attestationObject),
        clientDataJSON: encodeBase64Url(response.clientDataJSON)
      }
    };
  }
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    ...base,
    response: {
      authenticatorData: encodeBase64Url(response.authenticatorData),
      clientDataJSON: encodeBase64Url(response.clientDataJSON),
      signature: encodeBase64Url(response.signature),
      userHandle: encodeBase64Url(response.userHandle)
    }
  };
}

type PasskeyCeremony = {
  challengeId: string;
  credential: unknown;
};

let activeCeremony: Promise<unknown> | null = null;

export function passkeyErrorMessage(error: unknown, operation: 'create' | 'request' = 'create'): string {
  // Safari can expose WebAuthn errors from a different realm, so relying only
  // on `instanceof DOMException` would leak its raw English message.
  const candidate = error as { name?: unknown; message?: unknown } | null;
  const name = typeof candidate?.name === 'string' ? candidate.name : '';
  const message = typeof candidate?.message === 'string' ? candidate.message : String(error || '');
  if (name === 'InvalidStateError' || /invalidstateerror|object is in an invalid state/i.test(`${name} ${message}`)) {
    return operation === 'create'
      ? 'Passkey pada perangkat ini mungkin sudah terdaftar atau proses sebelumnya belum selesai. Gunakan passkey yang ada, selesaikan TOTP lalu coba lagi dari Administrasi Backend, atau gunakan perangkat lain.'
      : 'Sesi passkey pada perangkat ini tidak valid. Tutup permintaan passkey yang masih terbuka, muat ulang halaman, lalu coba lagi.';
  }
  if (name === 'NotAllowedError' || name === 'AbortError' || /notallowederror|aborted|timed out/i.test(`${name} ${message}`)) {
    return 'Permintaan passkey dibatalkan atau melewati batas waktu. Tekan tombol sekali dan selesaikan dialog perangkat.';
  }
  if (name === 'SecurityError') {
    return 'Passkey hanya dapat digunakan pada domain HTTPS eposyandu.app.';
  }
  return error instanceof Error && error.message
    ? error.message
    : 'Passkey tidak dapat diverifikasi pada perangkat ini.';
}

function normalizePasskeyError(error: unknown, operation: 'create' | 'request'): Error {
  return new Error(passkeyErrorMessage(error, operation));
}

function passkeyOptions(challenge: any): any {
  const challengeId = challenge?.id || challenge?.challenge_id;
  const options = challenge?.options;
  if (typeof challengeId !== 'string' || !options || typeof options !== 'object') {
    throw new Error('Challenge passkey tidak valid.');
  }
  return { challengeId, options };
}

async function completePasskeyCeremony(
  challenge: any,
  operation: 'create' | 'request'
): Promise<PasskeyCeremony> {
  if (activeCeremony) {
    throw new Error('Proses passkey sebelumnya masih berjalan. Selesaikan atau tutup dialog perangkat terlebih dahulu.');
  }
  if (!window.PublicKeyCredential || !navigator.credentials) {
    throw new Error('Perangkat atau browser ini belum mendukung passkey.');
  }
  const parsed = passkeyOptions(challenge);
  const ceremony = (async () => {
    try {
      const credential = operation === 'create'
        ? await navigator.credentials.create({ publicKey: creationOptions(parsed.options) })
        : await navigator.credentials.get({ publicKey: requestOptions(parsed.options) });
      if (!(credential instanceof PublicKeyCredential)) {
        throw new Error('Verifikasi passkey dibatalkan atau tidak menghasilkan kredensial.');
      }
      return {
        challengeId: parsed.challengeId,
        credential: serializeCredential(credential, operation)
      };
    } catch (error) {
      throw normalizePasskeyError(error, operation);
    }
  })();
  activeCeremony = ceremony;
  try {
    return await ceremony;
  } finally {
    if (activeCeremony === ceremony) activeCeremony = null;
  }
}

export async function completeWebAuthnRegistration(challenge: any): Promise<PasskeyCeremony> {
  return completePasskeyCeremony(challenge, 'create');
}

export async function completeWebAuthnAuthentication(challenge: any): Promise<PasskeyCeremony> {
  return completePasskeyCeremony(challenge, 'request');
}
