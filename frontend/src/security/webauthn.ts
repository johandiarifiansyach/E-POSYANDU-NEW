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
    rawId: credential.id,
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

export async function completeWebAuthnChallenge(challenge: any): Promise<{
  challengeId: string;
  operation: 'create' | 'request';
  credentialResponse: unknown;
}> {
  if (!window.PublicKeyCredential || !navigator.credentials) {
    throw new Error('Perangkat atau browser ini belum mendukung passkey.');
  }
  const operation = challenge?.webauthn?.type;
  const publicKey = challenge?.webauthn?.credential_options?.publicKey;
  if (!challenge?.id || !publicKey || !matchesOperation(operation)) {
    throw new Error('Challenge passkey tidak valid.');
  }
  let credential: Credential | null;
  if (operation === 'create') {
    credential = await navigator.credentials.create({ publicKey: creationOptions(publicKey) });
  } else {
    credential = await navigator.credentials.get({ publicKey: requestOptions(publicKey) });
  }
  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error('Verifikasi passkey dibatalkan atau tidak menghasilkan kredensial.');
  }
  return {
    challengeId: challenge.id,
    operation,
    credentialResponse: serializeCredential(credential, operation)
  };
}

function matchesOperation(value: unknown): value is 'create' | 'request' {
  return value === 'create' || value === 'request';
}
