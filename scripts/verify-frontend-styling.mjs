import { readFile } from 'node:fs/promises';

const config = await readFile(new URL('../frontend-react/tailwind.config.js', import.meta.url), 'utf8');
const postcss = await readFile(new URL('../frontend-react/postcss.config.js', import.meta.url), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('../frontend-react/package.json', import.meta.url), 'utf8'));

const requiredContent = [
  "'./index.html'",
  "'./src/**/*.{js,jsx,ts,tsx}'",
  "'./public/**/*.html'"
];
const missingContent = requiredContent.filter((entry) => !config.includes(entry));
if (missingContent.length) {
  throw new Error(`Tailwind content tidak lengkap: ${missingContent.join(', ')}`);
}
if (!postcss.includes('tailwindcss')) {
  throw new Error('PostCSS tidak memuat plugin Tailwind CSS.');
}

const dependencies = {
  ...(packageJson.dependencies || {}),
  ...(packageJson.devDependencies || {})
};
const runtimeCssInJs = Object.keys(dependencies).filter((name) =>
  name === 'styled-components' || name.startsWith('@emotion/')
);
if (runtimeCssInJs.length) {
  throw new Error(`Runtime CSS-in-JS tidak diizinkan: ${runtimeCssInJs.join(', ')}`);
}

console.log('Frontend styling OK: Tailwind purge aktif dan tidak ada runtime CSS-in-JS.');
