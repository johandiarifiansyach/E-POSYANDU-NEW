type ProblemPayload = {
  error: unknown;
  source: string;
  route: string;
  message: string;
  code: string;
  occurredAt: Date;
};

type ProblemReporterOptions = {
  report: (payload: ProblemPayload) => Promise<void>;
};

let panel: HTMLElement | null = null;
let payload: ProblemPayload | null = null;
let statusText: HTMLElement | null = null;
let reportButton: HTMLButtonElement | null = null;
let descriptionText: HTMLElement | null = null;
let codeText: HTMLElement | null = null;

function textFromError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function compactMessage(input: string): string {
  return input.replace(/\s+/g, ' ').trim().slice(0, 220) || 'Terjadi kesalahan tidak terduga.';
}

function hashCode(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36).slice(0, 8).toUpperCase();
}

function buildPayload(error: unknown, source: string): ProblemPayload {
  const route = window.location.pathname;
  const message = compactMessage(textFromError(error));
  const seed = `${source}|${route}|${message}`;
  return {
    error,
    source,
    route,
    message,
    code: hashCode(seed),
    occurredAt: new Date()
  };
}

function detailText(problem: ProblemPayload): string {
  return [
    'Laporan Masalah E-Posyandu',
    `Kode: ${problem.code}`,
    `Waktu: ${problem.occurredAt.toISOString()}`,
    `Sumber: ${problem.source}`,
    `Halaman: ${problem.route}`,
    `Pesan: ${problem.message}`
  ].join('\n');
}

function removePanel() {
  panel?.remove();
  panel = null;
  payload = null;
  statusText = null;
  reportButton = null;
  descriptionText = null;
  codeText = null;
}

function setStatus(message: string, tone: 'muted' | 'success' | 'error' = 'muted') {
  if (!statusText) return;
  statusText.textContent = message;
  statusText.dataset.tone = tone;
}

async function copyDetails(problem: ProblemPayload) {
  const detail = detailText(problem);
  try {
    await navigator.clipboard.writeText(detail);
    setStatus('Detail masalah disalin. Kirim ke admin jika diperlukan.', 'success');
  } catch {
    setStatus('Tidak bisa menyalin otomatis. Silakan laporkan kode masalah ke admin.', 'error');
  }
}

function createButton(label: string, className: string, onClick: () => void | Promise<void>) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', () => {
    void onClick();
  });
  return button;
}

function ensurePanel(options: ProblemReporterOptions) {
  if (panel) return;
  const root = document.createElement('aside');
  root.className = 'problem-reporter';
  root.setAttribute('role', 'alert');
  root.setAttribute('aria-live', 'assertive');

  const title = document.createElement('p');
  title.className = 'problem-reporter-title';
  title.textContent = 'Terjadi gangguan aplikasi';

  const description = document.createElement('p');
  description.className = 'problem-reporter-description';

  const code = document.createElement('p');
  code.className = 'problem-reporter-code';

  const actions = document.createElement('div');
  actions.className = 'problem-reporter-actions';

  const report = createButton('Laporkan Masalah', 'problem-reporter-btn is-primary', async () => {
    if (!payload) return;
    if (reportButton) reportButton.disabled = true;
    setStatus('Mengirim laporan masalah...', 'muted');
    try {
      await options.report(payload);
      setStatus('Laporan terkirim. Terima kasih, tim akan menindaklanjuti.', 'success');
    } catch {
      setStatus('Laporan gagal dikirim. Periksa koneksi lalu coba lagi.', 'error');
    } finally {
      if (reportButton) reportButton.disabled = false;
    }
  });
  reportButton = report;

  const copy = createButton('Salin Detail', 'problem-reporter-btn', async () => {
    if (!payload) return;
    await copyDetails(payload);
  });
  const close = createButton('Tutup', 'problem-reporter-btn', () => removePanel());

  actions.append(report, copy, close);

  const status = document.createElement('p');
  status.className = 'problem-reporter-status';
  status.dataset.tone = 'muted';
  status.textContent = 'Anda bisa tetap melanjutkan, lalu laporkan masalah ini.';

  root.append(title, description, code, actions, status);
  document.body.append(root);

  panel = root;
  statusText = status;
  descriptionText = description;
  codeText = code;
}

export function setupProblemReporter(options: ProblemReporterOptions) {
  return {
    capture(error: unknown, source: string) {
      payload = buildPayload(error, source);
      ensurePanel(options);
      if (!panel) return;
      if (descriptionText)
        descriptionText.textContent = payload.message;
      if (codeText)
        codeText.textContent = `Kode masalah: ${payload.code}`;
      setStatus('Anda bisa tetap melanjutkan, lalu laporkan masalah ini.', 'muted');
    }
  };
}