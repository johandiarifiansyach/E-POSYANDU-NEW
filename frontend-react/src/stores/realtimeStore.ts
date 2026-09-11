import { create } from "zustand";
import type { MonitoringStatus } from "../api/dashboardApi";

export type RealtimeState = {
  monitoringStatus: MonitoringStatus | null;
  setMonitoringStatus: (status: MonitoringStatus | null) => void;
};

/** Realtime connection state only; stream data belongs to its feature query. */
export const useRealtimeStore = create<RealtimeState>((set) => ({
  monitoringStatus: null,
  setMonitoringStatus: (monitoringStatus) => set({ monitoringStatus }),
}));
