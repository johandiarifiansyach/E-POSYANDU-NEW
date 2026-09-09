import type { ChangeEvent } from 'react';

export type SelectOption = { value: string | number; label: string };
export type AppSelectProps = {
  value: string | number;
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  options: SelectOption[];
  disabled?: boolean;
  required?: boolean;
  className?: string;
  ariaLabel?: string;
};

function ChevronDown() {
  return <svg className="pointer-events-none absolute right-3 top-3 h-4 w-4 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>;
}

export default function AppSelect({ value, onChange, options, disabled, required = false, className = '', ariaLabel }: AppSelectProps) {
  return <div className="relative w-full">
    <select value={value} onChange={onChange} disabled={disabled} required={required} aria-label={ariaLabel} className={`apple-select block w-full appearance-none rounded-xl border border-slate-200/70 bg-white/70 p-2.5 pr-8 text-sm text-slate-900 transition-shadow focus:border-blue-500 focus:ring-blue-500 disabled:bg-slate-100 disabled:text-slate-400 ${className}`}>
      {options.map((option) => <option key={String(option.value)} value={option.value}>{option.label}</option>)}
    </select>
    <ChevronDown />
  </div>;
}
