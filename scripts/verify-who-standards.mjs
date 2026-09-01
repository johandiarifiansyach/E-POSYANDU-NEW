import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readText = (path) => readFile(resolve(root, path), 'utf8');
const readJson = async (path) => JSON.parse(await readText(path));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const provenance = await readJson('docs/who-growth-standards.provenance.json');

for (const artifact of provenance.localArtifacts) {
  const contents = await readFile(resolve(root, artifact.path));
  assert.equal(sha256(contents), artifact.sha256, `${artifact.path} berubah tanpa pembaruan provenance WHO`);
}

const backend = await readJson('backend/data/anthropometry.json');
const analysis = await readJson('services/analysis-service/data/anthropometry.json');
assert.deepEqual(analysis, backend, 'Tabel WHO backend dan analysis-service harus identik');

const frontendSource = await readText('frontend/src/data/anthropometry.ts');
const prefix = 'export const WHO_0_TO_5 = ';
const start = frontendSource.indexOf(prefix);
const end = frontendSource.lastIndexOf(' as const;');
assert.ok(start >= 0 && end > start, 'Tabel antropometri frontend tidak dapat dibaca');
const frontend = JSON.parse(frontendSource.slice(start + prefix.length, end));
assert.deepEqual(frontend, backend, 'Tabel WHO frontend dan backend harus identik');

const circumferenceModule = await import(
  `${pathToFileURL(resolve(root, 'frontend/src/data/whoGrowthLms.ts')).href}?audit=${Date.now()}`
);
const circumference = circumferenceModule.WHO_GROWTH_LMS;
const expected = provenance.expectedRowsPerSex;

for (const sex of ['L', 'P']) {
  assert.equal(backend.weightForAge[sex].length, expected.weightForAge);
  assert.equal(backend.lengthHeightForAge[sex].length, expected.lengthHeightForAge);
  assert.equal(backend.bmiForAge[sex].length, expected.bmiForAge);
  assert.equal(backend.weightForLength[sex].length, expected.weightForLength);
  assert.equal(backend.weightForHeight[sex].length, expected.weightForHeight);
  assert.equal(circumference.lila[sex].length, expected.armCircumferenceForAge);
  assert.equal(circumference.lk[sex].length, expected.headCircumferenceForAge);
  assert.deepEqual(circumference.lila[sex].map((row) => row[0]), Array.from({ length: 58 }, (_, index) => index + 3));
  assert.deepEqual(circumference.lk[sex].map((row) => row[0]), Array.from({ length: 61 }, (_, index) => index));
}

const allLmsRows = [
  ...Object.values(backend).flatMap((indicator) => Object.values(indicator).flat()),
  ...Object.values(circumference).flatMap((indicator) => Object.values(indicator).flat().map((row) => row.slice(1)))
];
for (const row of allLmsRows) {
  assert.equal(row.length, 3, 'Setiap referensi WHO harus berisi L, M, dan S');
  assert.ok(row.every(Number.isFinite), 'Nilai LMS WHO harus berupa angka terbatas');
  assert.ok(row[1] > 0 && row[2] > 0, 'Median dan sebaran LMS WHO harus positif');
}

console.log(`Standar WHO terverifikasi: ${provenance.sourceArtifacts.length} artefak sumber, 6 indikator, 2 jenis kelamin.`);
