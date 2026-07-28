#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

loadEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
const inputDir = process.env.MIGRATION_EXPORT_DIR || path.resolve(__dirname, '../../migration-data/firestore-export');
const collections = (process.env.FIRESTORE_COLLECTIONS || 'children,measurements,mpasi_logs,pmt_programs,change_logs')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

if (!supabaseUrl || !supabaseServiceRole) {
  throw new Error('Set SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY di .env.');
}

const supabase = createClient(supabaseUrl, supabaseServiceRole, {
  auth: { persistSession: false }
});

let hasMismatch = false;

for (const tableName of collections) {
  const file = path.join(inputDir, `${tableName}.json`);
  const content = await fs.readFile(file, 'utf8');
  const docs = JSON.parse(content);

  const { count, error } = await supabase
    .from('documents')
    .select('*', { count: 'exact', head: true })
    .eq('table_name', tableName);

  if (error) throw error;

  const sourceCount = docs.length;
  const targetCount = count || 0;
  const ok = sourceCount === targetCount;
  if (!ok) hasMismatch = true;

  console.log(`${ok ? 'OK' : 'MISMATCH'} ${tableName}: source=${sourceCount} target=${targetCount}`);
}

if (hasMismatch) {
  process.exitCode = 1;
  console.error('Verifikasi gagal: ada jumlah dokumen yang tidak sama.');
} else {
  console.log('Verifikasi berhasil: semua jumlah dokumen sama.');
}
