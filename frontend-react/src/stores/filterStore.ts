import { create } from "zustand";
import type { AgeGroup } from "../config/ageFilters";

export type DashboardFilterScope = {
  month: number;
  year: number;
  ageGroup: AgeGroup;
  desa: string;
  posyandu: string;
};

type Updater<T> = T | ((current: T) => T);

export type FilterState = {
  /** Identifies the authenticated scope that owns the current filters. */
  ownerKey: string | null;
  draft: DashboardFilterScope;
  applied: DashboardFilterScope;
  initialize: (ownerKey: string, defaults: DashboardFilterScope) => void;
  setDraft: (value: Updater<DashboardFilterScope>) => void;
  applyDraft: () => void;
  reset: (defaults: DashboardFilterScope) => void;
  setAgeGroup: (ageGroup: AgeGroup) => void;
};

const now = new Date();
const EMPTY_SCOPE: DashboardFilterScope = {
  month: now.getMonth() + 1,
  year: now.getFullYear(),
  ageGroup: "0-59",
  desa: "",
  posyandu: "",
};

function update<T>(value: Updater<T>, current: T): T {
  return typeof value === "function"
    ? (value as (current: T) => T)(current)
    : value;
}

/**
 * Filter state is kept separate from UI and auth state.  Features can select
 * only `draft` or `applied`, avoiding a broad context update on every input.
 */
export const useFilterStore = create<FilterState>((set) => ({
  ownerKey: null,
  draft: EMPTY_SCOPE,
  applied: EMPTY_SCOPE,
  initialize: (ownerKey, defaults) =>
    set({ ownerKey, draft: defaults, applied: defaults }),
  setDraft: (value) =>
    set((state) => ({ draft: update(value, state.draft) })),
  applyDraft: () => set((state) => ({ applied: state.draft })),
  reset: (defaults) => set((state) => ({ draft: defaults, applied: defaults })),
  setAgeGroup: (ageGroup) =>
    set((state) => ({
      draft: { ...state.draft, ageGroup },
      applied: { ...state.applied, ageGroup },
    })),
}));
