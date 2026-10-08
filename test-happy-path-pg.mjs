#!/usr/bin/env node
// Test script pour happy path SQL — PostgreSQL
// Usage: node test-happy-path-pg.mjs

import { createPool } from 'pg';

// --- Setup PG test data ---
const pgPool = createPool({
  host: 'localhost',
  port: 55432,
  user: 'postgres',
  password: 'testpass',
  database: 'calame_test',
});

async function setupPg() {
  console.log('=== PostgreSQL Setup ===');
  
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100),
      email VARCHAR(150),
      phone VARCHAR(20),
      tier VARCHAR(20)
    );
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER REFERENCES customers(id),
      product VARCHAR(100),
      amount DECIMAL(10,2),
      status VARCHAR(20)
    );
  `);
  
  await pgPool.query(`
    INSERT INTO customers (name, email, phone, tier) VALUES
    ('Alice Dupont', 'alice@example.com', '0612345678', 'premium'),
    ('Bob Martin', 'bob@example.com', '0698765432', 'standard'),
    ('Claire Moreau', 'claire@example.com', '0655555555', 'premium');
  `);
  
  await pgPool.query(`
    INSERT INTO orders (customer_id, product, amount, status) VALUES
    (1, 'Widget Pro', 150.00, 'completed'),
    (1, 'Gadget X', 75.00, 'pending'),
    (2, 'Widget Basic', 50.00, 'completed'),
    (3, 'Gadget X', 75.00, 'shipped');
  `);
  
  const tables = await pgPool.query('SELECT table_name FROM information_schema.tables WHERE table_schema = \'public\' ORDER BY table_name');
  console.log('Tables created:', tables.rows.map(r => r.table_name).join(', '));
  
  const customerCount = await pgPool.query('SELECT COUNT(*) FROM customers');
  console.log('Customers:', customerCount.rows[0].count);
  
  const orderCount = await pgPool.query('SELECT COUNT(*) FROM orders');
  console.log('Orders:', orderCount.rows[0].count);
  
  return { tables: tables.rows, customerCount: customerCount.rows[0].count, orderCount: orderCount.rows[0].count };
}

async function testQueries() {
  console.log('\n=== PostgreSQL Direct Queries (pre-Calame) ===');
  
  // Query 1: All customers
  const all = await pgPool.query('SELECT id, name, email, phone, tier FROM customers');
  console.log('All customers:', all.rows.length, 'rows');
  console.log('  Row 1:', all.rows[0]);
  
  // Query 2: Orders with customer info
  const orders = await pgPool.query(`
    SELECT o.id, c.name, o.product, o.amount, o.status
    FROM orders o JOIN customers c ON o.customer_id = c.id
    WHERE o.status = 'completed'
  `);
  console.log('Completed orders:', orders.rows.length, 'rows');
  
  // Query 3: Revenue by tier
  const revenue = await pgPool.query(`
    SELECT c.tier, COUNT(*) as order_count, SUM(o.amount) as total
    FROM orders o JOIN customers c ON o.customer_id = c.id
    GROUP BY c.tier
  `);
  console.log('Revenue by tier:');
  for (const r of revenue.rows) {
    console.log(`  ${r.tier}: ${r.order_count} orders, $${r.total}`);
  }
}

async function cleanup() {
  await pgPool.query('DROP TABLE IF EXISTS orders CASCADE');
  await pgPool.query('DROP TABLE IF EXISTS customers CASCADE');
  await pgPool.end();
  console.log('\n=== PG Cleanup done ===');
}

async function main() {
  try {
    await setupPg();
    await testQueries();
    await cleanup();
    console.log('\n✅ PostgreSQL happy path OK');
  } catch (e) {
    console.error('❌ PostgreSQL happy path FAILED:', e.message);
    process.exit(1);
  }
}

main();
