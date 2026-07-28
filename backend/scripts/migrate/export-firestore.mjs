#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

loadEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const appId = process.env.FIREBASE_APP_ID || 'siposyandu-377b6';
const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
const outputDir = process.env.MIGRATION_EXPORT_DIR || path.resolve(__dirname, '../../../migration-data/firestore-export');
const explicitCollections = (process.env.FIRESTORE_COLLECTIONS || '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

if (!serviceAccountPath) {
  throw new Error('Set FIREBASE_SERVICE_ACCOUNT_PATH di .env (path ke service account JSON Firebase).');
}

const serviceAccountText = await fs.readFile(path.resolve(serviceAccountPath), 'utf8');
const serviceAccount = JSON.parse(serviceAccountText);

if (!getApps().length) {
  initializeApp({
    credential: cert(serviceAccount)
  });
}

const db = getFirestore();
const baseDocPath = `artifacts/${appId}/public/data`;

function serializeValue(value) {
  if (value instanceof Timestamp) {
    return value.toDate().toISOString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeValue(item));
  }

  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = serializeValue(v);
    }
    return out;
  }

  return value;
}

await fs.mkdir(outputDir, { recursive: true });

let collections = explicitCollections;
if (collections.length === 0) {
  const refs = await db.doc(baseDocPath).listCollections();
  collections = refs.map((ref) => ref.id).sort();
}

if (collections.length === 0) {
  throw new Error(`Tidak ada koleksi ditemukan di ${baseDocPath}.`);
}

const summary = {
  appId,
  baseDocPath,
  exportedAt: new Date().toISOString(),
  collections: {}
};

for (const name of collections) {
  const collectionPath = `${baseDocPath}/${name}`;
  console.log(`Exporting ${collectionPath} ...`);

  const snap = await db.collection(collectionPath).get();
  const docs = snap.docs.map((doc) => ({
    id: doc.id,
    data: serializeValue(doc.data())
  }));

  const target = path.join(outputDir, `${name}.json`);
  await fs.writeFile(target, JSON.stringify(docs, null, 2), 'utf8');

  summary.collections[name] = {
    count: docs.length,
    file: `${name}.json`
  };
}

await fs.writeFile(
  path.join(outputDir, 'summary.json'),
  JSON.stringify(summary, null, 2),
  'utf8'
);

console.log('Selesai export Firestore:', outputDir);
