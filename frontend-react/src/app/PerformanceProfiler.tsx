import {
  Profiler,
  type ProfilerOnRenderCallback,
  type ReactNode,
} from "react";

type PerformanceProfilerProps = {
  id: string;
  children: ReactNode;
};

/**
 * Opt-in React commit profiler for local performance investigations. React
 * DevTools can profile the same tree interactively; this callback gives us a
 * lightweight stream of commit timings when the extension is not available.
 * It is deliberately disabled in production and by default in development.
 */
export default function PerformanceProfiler({
  id,
  children,
}: PerformanceProfilerProps) {
  const enabled =
    import.meta.env.DEV && import.meta.env.VITE_REACT_PROFILER === "true";
  if (!enabled) return <>{children}</>;

  const onRender: ProfilerOnRenderCallback = (
    profilerId,
    phase,
    actualDuration,
    baseDuration,
    startTime,
    commitTime,
  ) => {
    // Keep this opt-in and dev-only: production requests must never pay for
    // profiling or emit potentially sensitive component timing information.
    console.debug("[React Profiler]", {
      id: profilerId,
      phase,
      actualDuration: Number(actualDuration.toFixed(2)),
      baseDuration: Number(baseDuration.toFixed(2)),
      startTime: Number(startTime.toFixed(2)),
      commitTime: Number(commitTime.toFixed(2)),
    });
  };

  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}
