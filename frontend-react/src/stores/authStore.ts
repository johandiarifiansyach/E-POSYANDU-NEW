import { create } from "zustand";
import type { DashboardUser } from "../types";

export type AuthState = {
  user: DashboardUser | null;
  setUser: (user: DashboardUser | null) => void;
  clearUser: () => void;
};

/** Minimal auth profile store. Tokens and MFA values remain outside global state. */
export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  setUser: (user) => set({ user }),
  clearUser: () => set({ user: null }),
}));
