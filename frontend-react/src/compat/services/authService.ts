// Authentication is owned by App.ts; this adapter keeps feature code independent
// from the authentication client implementation.
type SessionUser = {
    role?: string;
    desa?: string | null;
    posyandu?: string | null;
};

export const getUserScope = (user: SessionUser | null | undefined) => ({
    role: user?.role || '',
    desa: user?.desa || null,
    posyandu: user?.posyandu || null
});

export const hasRole = (user: SessionUser | null | undefined, role: string) => getUserScope(user).role === role;
