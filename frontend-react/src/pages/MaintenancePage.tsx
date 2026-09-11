export default function MaintenancePage({
  message = 'Kami sedang melakukan pemeliharaan sistem.',
  onRetry
}: {
  message?: string;
  onRetry?: () => void;
}) {
  return <main className="flex min-h-screen min-h-[100dvh] items-center justify-center bg-[#f2f2f7] px-5 py-10 text-slate-800">
    <section className="w-full max-w-xl rounded-3xl border border-white/80 bg-white/90 p-8 text-center shadow-xl backdrop-blur-xl sm:p-12" aria-labelledby="maintenance-title">
      <img src="/logo-puskesmas-32981.svg" alt="Logo Puskesmas Gumukmas" className="mx-auto mb-6 h-16 w-16 object-contain" width={64} height={64} loading="eager" decoding="async" />
      <p className="mb-3 text-xs font-bold uppercase tracking-[0.2em] text-emerald-600">E-Posyandu</p>
      <h1 id="maintenance-title" className="mb-4 text-2xl font-bold sm:text-3xl">Pemeliharaan Sistem</h1>
      <p className="mb-8 text-sm leading-6 text-slate-500">{message} Data tersimpan tetap aman. Silakan coba kembali beberapa saat lagi.</p>
      {onRetry ? <button type="button" onClick={onRetry} className="rounded-xl bg-[#007aff] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#006ee6]">Coba lagi</button> : null}
    </section>
  </main>;
}
