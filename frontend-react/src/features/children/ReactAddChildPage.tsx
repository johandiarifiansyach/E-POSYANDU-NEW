import { useMemo, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  serverTimestamp,
  syncPendingMutations,
  updateDoc,
} from "../../api/syncApi";
import {
  CHILD_BIRTH_DECIMAL_RULES,
  createInitialChildForm,
  generateTemporaryKk,
  generateTemporaryNik,
  normalizeChildInput,
  parseChildDecimalForRange,
  validateChildBirthMeasurements,
  formatChildName,
} from "./childRules";
import { appId, db } from "../../app/session";
import { DATA_WILAYAH, ROLES } from "../../config/dashboard";
import type { DashboardUser } from "../../types";
import { showSuccess } from "../../ui/notifications";
import { AppButton, AppSelect, Card, InputGroup } from "../../components/base";
import {
  Baby,
  CheckCircle2,
  ChevronLeft,
  MapPin,
  UserPlus,
  UserRound,
  X,
  XCircle,
} from "../../ui/icons";

type ChildForm = {
  nama: string;
  nik: string;
  anakKe: string;
  tglLahir: string;
  jk: string;
  noKK: string;
  hasKK: boolean;
  hasNIK: boolean;
  usiaKehamilan: string;
  bbLahir: string;
  pbLahir: string;
  lkLahir: string;
  bukuKIA: string;
  bukuKIAKecil: string;
  imd: string;
  namaOrtu: string;
  nikOrtu: string;
  noHpOrtu: string;
  alamat: string;
  rt: string;
  rw: string;
  desa: string;
  posyandu: string;
};

const inputClass =
  "block w-full rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-sm text-slate-900 transition-colors focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100";
const yesNoOptions = [
  { value: "", label: "Pilih jawaban" },
  { value: "Ya", label: "Ya" },
  { value: "Tidak", label: "Tidak" },
];

function fieldValue(form: ChildForm, field: keyof ChildForm): string {
  const value = form[field];
  return typeof value === "string" ? value : "";
}

export type ReactAddChildPageProps = {
  user: DashboardUser;
  allChildren?: any[];
  initialData?: Partial<ChildForm> & { id?: string };
  isEdit?: boolean;
  /** Render the native identity editor shell when opened from the table. */
  modal?: boolean;
  onBack: () => void;
  onSuccess: () => void;
};

/**
 * Strict React write form for registering a child. It deliberately uses the
 * same offline mutation queue as the existing Rust write boundary, so the
 * migration does not introduce a second persistence path.
 */
export default function ReactAddChildPage({
  user,
  allChildren = [],
  initialData,
  isEdit = false,
  modal = false,
  onBack,
  onSuccess,
}: ReactAddChildPageProps) {
  const [form, setForm] = useState<ChildForm>(() => ({
    ...(createInitialChildForm(user) as ChildForm),
    ...(initialData || {}),
  }));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const desaOptions = useMemo(
    () =>
      Object.keys(DATA_WILAYAH).map((desa) => ({ value: desa, label: desa })),
    [],
  );
  const posyanduOptions = useMemo(
    () =>
      (DATA_WILAYAH[form.desa as keyof typeof DATA_WILAYAH] || []).map(
        (posyandu) => ({ value: posyandu, label: posyandu }),
      ),
    [form.desa],
  );
  const setField = <K extends keyof ChildForm>(field: K, value: ChildForm[K]) =>
    setForm((current) => ({ ...current, [field]: value }));
  const setTextField = (field: keyof ChildForm, value: string) =>
    setField(field, value as ChildForm[typeof field]);
  const decimalChange = (field: keyof ChildForm, value: string) =>
    setTextField(field, normalizeChildInput(value));
  const decimalBlur = (field: keyof ChildForm) => {
    const value = fieldValue(form, field);
    const rule =
      CHILD_BIRTH_DECIMAL_RULES[
        field as keyof typeof CHILD_BIRTH_DECIMAL_RULES
      ];
    if (!rule) return;
    const parsed = parseChildDecimalForRange(
      value,
      rule.minimum,
      rule.maximum,
      rule.shift,
    );
    if (Number.isFinite(parsed))
      setTextField(
        field,
        String(parsed)
          .replace(/\.0+$/, "")
          .replace(/(\.\d*?)0+$/, "$1"),
      );
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const birth = validateChildBirthMeasurements({
      bbLahir: form.bbLahir,
      pbLahir: form.pbLahir,
      lkLahir: form.lkLahir,
    }) as {
      ok: boolean;
      message?: string;
      data?: { bbLahir: number; pbLahir: number; lkLahir: number };
    };
    if (!birth.ok) {
      setError(birth.message || "Data kelahiran belum valid.");
      return;
    }
    if (!birth.data) {
      setError("Data kelahiran belum lengkap.");
      return;
    }
    const submission = {
      ...form,
      nama: formatChildName(form.nama),
      bbLahir: String(birth.data.bbLahir),
      pbLahir: String(birth.data.pbLahir),
      lkLahir: String(birth.data.lkLahir),
      noKK:
        form.hasKK || /^\d{16}$/.test(form.noKK)
          ? form.noKK
          : generateTemporaryKk(),
      nik:
        form.hasNIK || /^\d{16}$/.test(form.nik)
          ? form.nik
          : (generateTemporaryNik as (...args: any[]) => string)(
              form,
              allChildren,
            ),
    };
    if (!/^\d{16}$/.test(submission.noKK)) {
      setError("No. KK harus berisi 16 digit.");
      return;
    }
    if (!/^\d{16}$/.test(submission.nik)) {
      setError("NIK balita harus berisi 16 digit.");
      return;
    }
    setForm(submission);
    setSaving(true);
    try {
      if (isEdit && initialData?.id) {
        await updateDoc(
          doc(
            db,
            "artifacts",
            appId,
            "public",
            "data",
            "children",
            initialData.id,
          ),
          { ...submission, updatedAt: serverTimestamp() },
          { deferSync: true },
        );
        await syncPendingMutations();
      } else {
        const child = await addDoc(
          collection(db, "artifacts", appId, "public", "data", "children"),
          {
            ...submission,
            currentBB: submission.bbLahir,
            currentTB: submission.pbLahir,
            currentLK: submission.lkLahir,
            currentLILA: 0,
            createdAt: serverTimestamp(),
            createdBy: user.role,
            deletedAt: null,
          },
        );
        const birthMeasurement = await addDoc(
          collection(db, "artifacts", appId, "public", "data", "measurements"),
          {
            childId: child.id,
            childName: submission.nama,
            posyandu: submission.posyandu,
            desa: submission.desa,
            tglUkur: submission.tglLahir,
            bb: submission.bbLahir,
            tb: submission.pbLahir,
            lk: submission.lkLahir,
            lila: "",
            edema: "Tidak",
            kelasIbu: "Tidak",
            mbg: "Tidak",
            vitA: "Tidak",
            asi: "Ya",
            caraUkur: "Terlentang",
            statusNaik: "B",
            ageInMonths: 0,
            createdAt: serverTimestamp(),
          },
        );
        await syncPendingMutations([
          child.mutationId,
          birthMeasurement.mutationId,
        ]);
      }
      showSuccess(
        isEdit
          ? "Data balita berhasil diperbarui."
          : "Data balita berhasil ditambahkan.",
      );
      onSuccess();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Data balita belum dapat disimpan.",
      );
    } finally {
      setSaving(false);
    }
  };

  const select = (
    field: keyof ChildForm,
    label: string,
    options: Array<{ value: string; label: string }>,
    disabled = false,
  ) => (
    <InputGroup label={label}>
      <AppSelect
        required
        value={fieldValue(form, field)}
        disabled={disabled}
        options={options}
        onChange={(event) => {
          const value = event.target.value;
          if (field === "desa") {
            const nextPosyandu =
              DATA_WILAYAH[value as keyof typeof DATA_WILAYAH]?.[0] || "";
            setForm((current) => {
              const next = { ...current, desa: value, posyandu: nextPosyandu };
              if (!current.hasNIK)
                next.nik = (generateTemporaryNik as (...args: any[]) => string)(
                  next,
                  allChildren,
                );
              return next;
            });
          } else if (field === "posyandu") {
            setForm((current) => {
              const next = { ...current, posyandu: value };
              if (!current.hasNIK)
                next.nik = (generateTemporaryNik as (...args: any[]) => string)(
                  next,
                  allChildren,
                );
              return next;
            });
          } else setTextField(field, value);
        }}
      />
    </InputGroup>
  );
  const text = (
    field: keyof ChildForm,
    label: string,
    required = true,
    type = "text",
    extra: Record<string, unknown> = {},
  ) => (
    <InputGroup label={label}>
      <input
        {...extra}
        name={field}
        required={required}
        type={type}
        className={`${inputClass} ${typeof extra.className === "string" ? extra.className : ""}`.trim()}
        value={fieldValue(form, field)}
        onChange={(event) => {
          const value = event.target.value;
          const shouldNormalize = field === "anakKe" || field === "usiaKehamilan";
          setForm((current) => {
            const next = {
              ...current,
              [field]:
                field === "nama"
                  ? formatChildName(value)
                  : shouldNormalize
                    ? normalizeChildInput(value)
                    : value,
            };
            if (field === "tglLahir" && !current.hasNIK)
              next.nik = (generateTemporaryNik as (...args: any[]) => string)(
                next,
                allChildren,
              );
            return next;
          });
        }}
        onBlur={
          typeof extra.onBlur === "function"
            ? (extra.onBlur as React.FocusEventHandler<HTMLInputElement>)
            : field === "anakKe" || field === "usiaKehamilan"
              ? () => decimalBlur(field)
              : undefined
        }
      />
    </InputGroup>
  );

  const modalInputClass =
    "ios-liquid-control w-full text-slate-900 text-sm rounded-xl block p-2.5 transition-colors";
  const modalText = (
    field: keyof ChildForm,
    label: string,
    required = true,
    type = "text",
    extra: Record<string, unknown> = {},
  ) => (
    <InputGroup label={label}>
      <input
        {...extra}
        name={field}
        required={required}
        type={type}
        className={modalInputClass}
        value={fieldValue(form, field)}
        onChange={(event) => {
          const value = event.target.value;
          setForm((current) => {
            const next = {
              ...current,
              [field]: field === "nama" ? formatChildName(value) : value,
            };
            if (field === "tglLahir" && !current.hasNIK)
              next.nik = (generateTemporaryNik as (...args: any[]) => string)(
                next,
                allChildren,
              );
            return next;
          });
        }}
      />
    </InputGroup>
  );

  if (modal) {
    return (
      <div
        className="identity-modal-backdrop ios-modal-backdrop fixed inset-0 z-50 flex items-center justify-center"
        data-identity-modal="true"
        data-identity-mode={isEdit ? "edit" : "create"}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !saving) onBack();
        }}
      >
        <div
          className="identity-modal-panel ios-liquid-modal ios-identity-modal w-full max-w-4xl"
          role="dialog"
          aria-modal="true"
          aria-labelledby="react-identity-modal-title"
        >
          <header className="identity-modal-header ios-modal-header z-10">
            <div className="ios-modal-title-group">
              <span
                className="apple-symbol-tile apple-symbol-tile-cyan"
                aria-hidden="true"
              >
                <Baby className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <h2 id="react-identity-modal-title">
                  {isEdit ? "Edit Identitas Balita" : "Registrasi Balita Baru"}
                </h2>
                <p>
                  {isEdit
                    ? fieldValue(form, "nama")
                    : "Lengkapi identitas dan data kelahiran"}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onBack}
              className="ios-modal-close"
              title="Tutup"
              aria-label="Tutup form identitas"
              disabled={saving}
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          <form
            onSubmit={submit}
            className="identity-modal-scroll ios-modal-body space-y-8"
            data-identity-modal-scroll="true"
          >
            <section className="space-y-4">
              <h3 className="font-semibold text-slate-800">
                Lokasi Pencatatan
              </h3>
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                {select(
                  "desa",
                  "Desa",
                  desaOptions,
                  user.role === ROLES.KADER || user.role === ROLES.BIDAN,
                )}
                {select(
                  "posyandu",
                  "Posyandu",
                  posyanduOptions,
                  user.role === ROLES.KADER,
                )}
              </div>
            </section>

            <section className="space-y-4">
              <h3 className="font-semibold text-slate-800">Identitas Balita</h3>
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                {modalText("nama", "Nama Lengkap Balita")}
                <div className="grid grid-cols-2 gap-4">
                  {modalText("anakKe", "Anak Ke-", true, "text", {
                    inputMode: "numeric",
                  })}
                  {select("jk", "Jenis Kelamin", [
                    { value: "", label: "Pilih jenis kelamin" },
                    { value: "L", label: "Laki-laki" },
                    { value: "P", label: "Perempuan" },
                  ])}
                </div>
                {modalText("tglLahir", "Tanggal Lahir", true, "date")}
                {modalText(
                  "usiaKehamilan",
                  "Usia Kehamilan (Minggu)",
                  true,
                  "text",
                  { inputMode: "numeric" },
                )}
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <label className="block text-xs font-bold uppercase tracking-wider text-slate-500">
                      No. KK
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 text-xs font-medium normal-case text-emerald-600 hover:text-emerald-700">
                      <input
                        type="checkbox"
                        className="rounded text-emerald-600 focus:ring-emerald-500"
                        checked={!form.hasKK}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            hasKK: !event.target.checked,
                            noKK: event.target.checked
                              ? generateTemporaryKk()
                              : "",
                          }))
                        }
                      />
                      Tidak punya KK
                    </label>
                  </div>
                  <input
                    name="noKK"
                    required={form.hasKK}
                    readOnly={!form.hasKK}
                    inputMode="numeric"
                    pattern="[0-9]{16}"
                    maxLength={16}
                    title="No. KK harus 16 digit"
                    type="text"
                    className={`${modalInputClass} font-mono tracking-wider ${!form.hasKK ? "bg-slate-200 text-slate-500" : "bg-white"}`}
                    value={form.noKK}
                    onChange={(event) =>
                      setTextField("noKK", event.target.value.replace(/\D/g, ""))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <label className="block text-xs font-bold uppercase tracking-wider text-slate-500">
                      NIK Balita
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 text-xs font-medium normal-case text-emerald-600 hover:text-emerald-700">
                      <input
                        type="checkbox"
                        className="rounded text-emerald-600 focus:ring-emerald-500"
                        checked={!form.hasNIK}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            hasNIK: !event.target.checked,
                            nik: event.target.checked
                              ? (generateTemporaryNik as (...args: any[]) => string)(
                                  current,
                                  allChildren,
                                )
                              : "",
                          }))
                        }
                      />
                      Tidak punya NIK
                    </label>
                  </div>
                  <input
                    name="nik"
                    required={form.hasNIK}
                    readOnly={!form.hasNIK}
                    inputMode="numeric"
                    pattern="[0-9]{16}"
                    maxLength={16}
                    title="NIK balita harus 16 digit"
                    type="text"
                    className={`${modalInputClass} font-mono tracking-wider ${!form.hasNIK ? "bg-slate-200 text-slate-500" : "bg-white"}`}
                    value={form.nik}
                    onChange={(event) =>
                      setTextField("nik", event.target.value.replace(/\D/g, ""))
                    }
                  />
                </div>
              </div>
            </section>

            <section className="space-y-4">
              <h3 className="font-semibold text-slate-800">Data Kelahiran</h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                {(["bbLahir", "pbLahir", "lkLahir"] as const).map((field) => (
                  <InputGroup
                    key={field}
                    label={
                      field === "bbLahir"
                        ? "Berat Lahir (kg)"
                        : field === "pbLahir"
                          ? "Panjang Lahir (cm)"
                          : "Lingkar Kepala (cm)"
                    }
                  >
                    <input
                      name={field}
                      required
                      type="text"
                      inputMode="decimal"
                      className={modalInputClass}
                      value={form[field]}
                      onChange={(event) =>
                        decimalChange(field, event.target.value)
                      }
                      onBlur={() => decimalBlur(field)}
                    />
                  </InputGroup>
                ))}
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                {select("bukuKIA", "Buku KIA", yesNoOptions)}
                {select("bukuKIAKecil", "Buku KIA Kecil", yesNoOptions)}
                {select("imd", "IMD", yesNoOptions)}
              </div>
              <p className="text-[11px] italic text-slate-500">
                Buku KIA bayi kecil dijawab Ya jika BBLR/prematur dan menerima
                Buku KIA bayi kecil.
              </p>
            </section>

            <section className="space-y-4">
              <h3 className="font-semibold text-slate-800">Data Orang Tua</h3>
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                {modalText("namaOrtu", "Nama Orang Tua")}
                {modalText("nikOrtu", "NIK Orang Tua", true, "text", {
                  inputMode: "numeric",
                  pattern: "[0-9]{16}",
                  maxLength: 16,
                })}
              </div>
              <InputGroup label="Alamat Lengkap">
                <textarea
                  name="alamat"
                  required
                  rows={2}
                  className={modalInputClass}
                  value={form.alamat}
                  onChange={(event) => setTextField("alamat", event.target.value)}
                />
              </InputGroup>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                {modalText("noHpOrtu", "No. HP", true, "tel", {
                  inputMode: "tel",
                  pattern: "[0-9]{8,15}",
                  maxLength: 15,
                })}
                {modalText("rt", "RT", true, "text", { inputMode: "numeric" })}
                {modalText("rw", "RW", true, "text", { inputMode: "numeric" })}
              </div>
            </section>

            {error ? (
              <div
                className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
                role="alert"
              >
                {error}
              </div>
            ) : null}
            <div className="identity-modal-actions ios-modal-actions">
              <AppButton
                type="button"
                variant="secondary"
                onClick={onBack}
                className="ios-modal-secondary w-full md:w-auto"
                disabled={saving}
              >
                Batal
              </AppButton>
              <AppButton
                type="submit"
                disabled={saving}
                className="ios-modal-primary w-full md:w-auto"
              >
                {saving ? "Menyimpan..." : isEdit ? "Perbarui Data" : "Simpan Data"}
              </AppButton>
            </div>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div
      className="add-child-page apple-page space-y-6"
      data-add-child-page="true"
      data-react-add-child-page="true"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <AppButton
            type="button"
            variant="secondary"
            onClick={onBack}
            className="ios-back-button mb-4"
            title="Kembali ke daftar balita"
          >
            <ChevronLeft className="h-4 w-4" /> Kembali
          </AppButton>
          <div className="flex items-center gap-3">
            <span
              className="apple-symbol-tile apple-symbol-tile-blue"
              aria-hidden="true"
            >
              <UserPlus className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-2xl font-bold text-slate-800">
                {isEdit ? "Edit Data Balita" : "Registrasi Balita Baru"}
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Data identitas, kelahiran, dan orang tua
              </p>
            </div>
          </div>
        </div>
      </div>
      <Card className="p-4 sm:p-6">
        <form onSubmit={submit} className="space-y-8">
          <section className="space-y-4">
            <div className="ios-form-section-header text-slate-800">
              <span
                className="apple-symbol-tile apple-symbol-tile-green"
                aria-hidden="true"
              >
                <MapPin className="h-4 w-4" />
              </span>
              <h3 className="font-semibold">Lokasi Pencatatan</h3>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {select(
                "desa",
                "Desa",
                desaOptions,
                user.role === ROLES.KADER || user.role === ROLES.BIDAN,
              )}
              {select(
                "posyandu",
                "Posyandu",
                posyanduOptions,
                user.role === ROLES.KADER,
              )}
            </div>
          </section>
          <section className="space-y-4 border-t border-slate-200 pt-6">
            <div className="ios-form-section-header text-slate-800">
              <span
                className="apple-symbol-tile apple-symbol-tile-cyan"
                aria-hidden="true"
              >
                <Baby className="h-4 w-4" />
              </span>
              <h3 className="font-semibold">Identitas dan Kelahiran</h3>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {text("nama", "Nama Lengkap Balita")}
              <div className="grid grid-cols-2 gap-4">
                {text("anakKe", "Anak Ke-", true, "text", {
                  inputMode: "numeric",
                })}
                {select("jk", "Jenis Kelamin", [
                  { value: "", label: "Pilih jenis kelamin" },
                  { value: "L", label: "Laki-laki" },
                  { value: "P", label: "Perempuan" },
                ])}
              </div>
              {text("tglLahir", "Tanggal Lahir", true, "date", {
                className: "min-h-12 text-base",
              })}
              {text("usiaKehamilan", "Usia Kehamilan (Minggu)", true, "text", {
                inputMode: "numeric",
              })}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <label className="text-xs font-bold uppercase text-slate-500">
                    No. KK
                  </label>
                  <label className="ios-form-switch text-xs font-medium text-emerald-700">
                    <input
                      type="checkbox"
                      className="ios-form-switch-input"
                      checked={!form.hasKK}
                      onChange={(event) => {
                        const hasKK = !event.target.checked;
                        setForm((current) => ({
                          ...current,
                          hasKK,
                          noKK: hasKK ? "" : generateTemporaryKk(),
                        }));
                      }}
                    />
                    <span className="ios-form-switch-track" aria-hidden="true" />
                    <span>Tidak punya KK</span>
                  </label>
                </div>
                <input
                  name="noKK"
                  required={form.hasKK}
                  readOnly={!form.hasKK}
                  inputMode="numeric"
                  pattern="[0-9]{16}"
                  maxLength={16}
                  title="No. KK harus 16 digit"
                  type="text"
                  className={`${inputClass} font-mono ${!form.hasKK ? "bg-slate-200 text-slate-500" : "bg-white"}`}
                  value={form.noKK}
                  onChange={(event) =>
                    setTextField("noKK", event.target.value.replace(/\D/g, ""))
                  }
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <label className="text-xs font-bold uppercase text-slate-500">
                    NIK Balita
                  </label>
                  <label className="ios-form-switch text-xs font-medium text-emerald-700">
                    <input
                      type="checkbox"
                      className="ios-form-switch-input"
                      checked={!form.hasNIK}
                      onChange={(event) => {
                        const hasNIK = !event.target.checked;
                        setForm((current) => ({
                          ...current,
                          hasNIK,
                          nik: hasNIK
                            ? ""
                            : (generateTemporaryNik as (...args: any[]) => string)(
                                current,
                                allChildren,
                              ),
                        }));
                      }}
                    />
                    <span className="ios-form-switch-track" aria-hidden="true" />
                    <span>Tidak punya NIK</span>
                  </label>
                </div>
                <input
                  name="nik"
                  required={form.hasNIK}
                  readOnly={!form.hasNIK}
                  inputMode="numeric"
                  pattern="[0-9]{16}"
                  maxLength={16}
                  title="NIK balita harus 16 digit"
                  type="text"
                  className={`${inputClass} font-mono ${!form.hasNIK ? "bg-slate-200 text-rose-700" : "bg-white"}`}
                  value={form.nik}
                  onChange={(event) =>
                    setTextField("nik", event.target.value.replace(/\D/g, ""))
                  }
                />
              </div>
              {(["bbLahir", "pbLahir", "lkLahir"] as const).map((field) => (
                <InputGroup
                  key={field}
                  label={
                    field === "bbLahir"
                      ? "Berat Lahir (kg)"
                      : field === "pbLahir"
                        ? "Panjang Lahir (cm)"
                        : "Lingkar Kepala (cm)"
                  }
                >
                  <input
                    name={field}
                    required
                    inputMode="decimal"
                    placeholder={field === "bbLahir" ? "Contoh: 3.20" : undefined}
                    title={
                      field === "bbLahir"
                        ? "Masukkan kilogram, misalnya 3.2. Jangan masukkan 3200 gram."
                        : undefined
                    }
                    className={inputClass}
                    value={form[field]}
                    onInvalid={(event) => {
                      if (field === "bbLahir")
                        event.currentTarget.setCustomValidity(
                          "Masukkan berat lahir dalam kilogram, misalnya 3.2. Jangan masukkan 3200 gram.",
                        );
                    }}
                    onInput={(event) => {
                      event.currentTarget.setCustomValidity("");
                      decimalChange(field, event.currentTarget.value);
                    }}
                    onChange={(event) => decimalChange(field, event.target.value)}
                    onBlur={() => decimalBlur(field)}
                  />
                </InputGroup>
              ))}
              {select("bukuKIA", "Buku KIA", yesNoOptions)}
              <InputGroup label="Buku KIA Kecil">
                <AppSelect
                  required
                  value={fieldValue(form, "bukuKIAKecil")}
                  options={yesNoOptions}
                  onChange={(event) =>
                    setTextField("bukuKIAKecil", event.target.value)
                  }
                />
                <p className="text-[11px] font-semibold italic leading-4 normal-case text-slate-500">
                  Hanya jawab YA apabila berat bayi lahir di bawah 2.5 Kg
                  (BBLR) dan bayi lahir prematur serta mendapatkan Buku KIA bayi
                  kecil.
                </p>
              </InputGroup>
              {select("imd", "IMD", yesNoOptions)}
            </div>
          </section>
          <section className="space-y-4 border-t border-slate-200 pt-6">
            <div className="ios-form-section-header text-slate-800">
              <span
                className="apple-symbol-tile apple-symbol-tile-purple"
                aria-hidden="true"
              >
                <UserRound className="h-4 w-4" />
              </span>
              <h3 className="font-semibold">Data Orang Tua</h3>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {text("namaOrtu", "Nama Orang Tua")}
              {text("nikOrtu", "NIK Orang Tua", true, "text", {
                inputMode: "numeric",
                pattern: "[0-9]{16}",
                maxLength: 16,
              })}
            </div>
            <InputGroup label="Alamat Lengkap">
              <textarea
                name="alamat"
                required
                rows={2}
                className={inputClass}
                value={form.alamat}
                onChange={(event) => setTextField("alamat", event.target.value)}
              />
            </InputGroup>
            <div className="grid gap-4 sm:grid-cols-3">
              {text("noHpOrtu", "No. HP", true, "text", {
                inputMode: "tel",
                pattern: "[0-9]{8,15}",
                maxLength: 15,
              })}
              {text("rt", "RT", true, "text", { inputMode: "numeric" })}
              {text("rw", "RW", true, "text", { inputMode: "numeric" })}
            </div>
          </section>
          {error ? (
            <p
              role="alert"
              className="ios-inline-notification ios-inline-notification-error"
            >
              {error}
            </p>
          ) : null}
          <div className="flex flex-col-reverse gap-3 border-t border-slate-200 pt-6 sm:flex-row sm:justify-end">
            <AppButton
              variant="secondary"
              type="button"
              onClick={onBack}
              className="w-full sm:w-auto"
            >
              <XCircle className="h-4 w-4" /> Batal
            </AppButton>
            <AppButton
              type="submit"
              disabled={saving}
              className="w-full sm:w-auto"
            >
              <CheckCircle2 className="h-4 w-4" />{" "}
              {saving
                ? "Menyimpan..."
                : isEdit
                  ? "Simpan Perubahan"
                  : "Simpan Data Balita"}
            </AppButton>
          </div>
        </form>
      </Card>
    </div>
  );
}
