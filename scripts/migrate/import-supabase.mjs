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

const BATCH_SIZE = Number(process.env.MIGRATION_BATCH_SIZE || 500);

for (const tableName of collections) {
  const file = path.join(inputDir, `${tableName}.json`);
  const content = await fs.readFile(file, 'utf8');
  const docs = JSON.parse(content);

  console.log(`Importing ${tableName}: ${docs.length} docs`);

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const chunk = docs.slice(i, i + BATCH_SIZE).map((item) => ({
      table_name: tableName,
      id: item.id,
      data: item.data,
      updated_at: new Date().toISOString()
    }));

    const { error } = await supabase
      .from('documents')
      .upsert(chunk, { onConflict: 'table_name,id', ignoreDuplicates: false });

    if (error) {
      throw new Error(`Gagal import ${tableName} batch ${i}-${i + chunk.length}: ${error.message}`);
    }
  }
}

console.log('Selesai import ke Supabase.');
