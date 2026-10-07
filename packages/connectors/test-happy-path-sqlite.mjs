#!/usr/bin/env node
// Test script pour happy path SQL — SQLite
// Usage: node packages/connectors/test-happy-path-sqlite.mjs
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';

const DB_PATH = '../../demo-logistique-v2.db';

function main() {
  console.log('=== SQLite Happy Path (demo-logistique-v2.db) ===\n');
  
  try {
    readFileSync(DB_PATH);
    console.log('✓ Demo DB found:', DB_PATH);
  } catch {
    console.error('❌ Demo DB not found at', DB_PATH);
    process.exit(1);
  }
  
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  console.log(`\n📊 Tables: ${tables.length}`);
  for (const t of tables.slice(0, 10)) {
    console.log(`  - ${t.name}`);
  }
  if (tables.length > 10) {
    console.log(`  ... and ${tables.length - 10} more`);
  }
  
  console.log('\n📋 Sample data:');
  
  for (const t of tables) {
    try {
      const count = db.prepare(`SELECT COUNT(*) as cnt FROM "${t.name}"`).get();
      if (count.cnt > 0) {
        const sample = db.prepare(`SELECT * FROM "${t.name}" LIMIT 2`).all();
        const cols = Object.keys(sample[0]);
        console.log(`  ${t.name}: ${count.cnt} rows, cols: ${cols.slice(0, 8).join(', ')}${cols.length > 8 ? '...' : ''}`);
        for (const row of sample) {
          console.log(`    → ${JSON.stringify(row)}`);
        }
      }
    } catch (e) {
      // skip
    }
  }
  
  console.log('\n🔍 Sample queries:');
  
  const colis = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%colis%'").all();
  if (colis.length > 0) {
    const count = db.prepare(`SELECT COUNT(*) as cnt FROM "${colis[0].name}"`).get();
    console.log(`  ${colis[0].name}: ${count.cnt} rows`);
    const sample = db.prepare(`SELECT * FROM "${colis[0].name}" LIMIT 1`).get();
    console.log(`    Sample: ${JSON.stringify(sample)}`);
  }
  
  const clients = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%client%'").all();
  if (clients.length > 0) {
    const count = db.prepare(`SELECT COUNT(*) as cnt FROM "${clients[0].name}"`).get();
    console.log(`  ${clients[0].name}: ${count.cnt} rows`);
  }
  
  db.close();
  console.log('\n✅ SQLite happy path OK');
}

main();
