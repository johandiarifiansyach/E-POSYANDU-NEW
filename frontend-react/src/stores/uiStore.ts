import { create } from "zustand";
import {
  getPreferredColorScheme,
  saveColorScheme,
  type ColorScheme,
} from "../theme/colorScheme";
import { COMPACT_SIDEBAR_MEDIA_QUERY } from "../config/dashboard";

type Updater<T> = T | ((current: T) => T);

export type UiState = {
  sidebarCollapsed: boolean;
  sidebarOpen: boolean;
  accountOpen: boolean;
  releaseNotesOpen: boolean;
  colorScheme: ColorScheme;
  setSidebarCollapsed: (value: Updater<boolean>) => void;
  setSidebarOpen: (value: Updater<boolean>) => void;
  setAccountOpen: (value: Updater<boolean>) => void;
  setReleaseNotesOpen: (value: Updater<boolean>) => void;
  setColorScheme: (value: ColorScheme) => void;
  toggleColorScheme: () => void;
};

function initialSidebarCollapsed() {
  if (typeof window === "undefined") return false;
  return window.matchMedia(COMPACT_SIDEBAR_MEDIA_QUERY).matches ||
    window.matchMedia("(max-width: 767px)").matches;
}

function update<T>(value: Updater<T>, current: T): T {
  return typeof value === "function"
    ? (value as (current: T) => T)(current)
    : value;
}

/**
 * UI-only state.  It deliberately excludes page data and form values so a
 * theme/sidebar update cannot invalidate query or feature state.
 */
export const useUiStore = create<UiState>((set, get) => ({
  sidebarCollapsed: initialSidebarCollapsed(),
  sidebarOpen: false,
  accountOpen: false,
  releaseNotesOpen: false,
  colorScheme: getPreferredColorScheme(),
  setSidebarCollapsed: (value) =>
    set((state) => ({ sidebarCollapsed: update(value, state.sidebarCollapsed) })),
  setSidebarOpen: (value) =>
    set((state) => ({ sidebarOpen: update(value, state.sidebarOpen) })),
  setAccountOpen: (value) =>
    set((state) => ({ accountOpen: update(value, state.accountOpen) })),
  setReleaseNotesOpen: (value) =>
    set((state) => ({ releaseNotesOpen: update(value, state.releaseNotesOpen) })),
  setColorScheme: (value) => set({ colorScheme: value }),
  toggleColorScheme: () => {
    const next = get().colorScheme === "dark" ? "light" : "dark";
    saveColorScheme(next);
    set({ colorScheme: next });
  },
}));
