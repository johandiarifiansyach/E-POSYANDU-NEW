/** Shared authenticated write-session boundary used by React forms. */
import { initializeApp } from '../api/authApi';
import { getFirestore } from '../api/syncApi';

const app = initializeApp({ projectId: import.meta.env.VITE_APP_ID || 'siposyandu-377b6' });

export const db = getFirestore(app);
export const appId = import.meta.env.VITE_APP_ID || 'siposyandu-377b6';

export function getSessionScope(user: { role?: string; desa?: string | null; posyandu?: string | null } | null | undefined) {
  return { role: user?.role || '', desa: user?.desa || null, posyandu: user?.posyandu || null };
}
