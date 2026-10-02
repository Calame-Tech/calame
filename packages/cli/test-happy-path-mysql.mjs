#!/usr/bin/env node
// Test script pour happy path SQL — MySQL
// Usage: node packages/cli/test-happy-path-mysql.mjs
import mysql from 'mysql2/promise';

async function main() {
  console.log('=== MySQL Setup ===\n');
  
  const connection = await mysql.createConnection({
    host: 'localhost',
    port: 53306,
    user: 'root',
    password: 'testpass',
    database: 'calame_test',
  });
  
  console.log('📊 Creating tables...');
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS products (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      category VARCHAR(50),
      price DECIMAL(10,2),
      stock INT DEFAULT 0
    )
  `);
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS customers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(150),
      country VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_id INT,
      product_id INT,
      quantity INT,
      total DECIMAL(10,2),
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Foreign keys after table creation
  await connection.execute(`ALTER TABLE orders ADD CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers(id)`);
  await connection.execute(`ALTER TABLE orders ADD CONSTRAINT fk_orders_product FOREIGN KEY (product_id) REFERENCES products(id)`);
  console.log('✓ Tables created: products, customers, orders');
  
  await connection.execute(`
    INSERT INTO products (name, category, price, stock) VALUES
    ('Widget Pro', 'widgets', 150.00, 50),
    ('Gadget X', 'gadgets', 75.00, 100),
    ('Basic Widget', 'widgets', 50.00, 200),
    ('Premium Gadget', 'gadgets', 200.00, 25),
    ('Super Tool', 'tools', 125.00, 75)
  `);
  
  await connection.execute(`
    INSERT INTO customers (name, email, country) VALUES
    ('Alice Dupont', 'alice@example.com', 'FR'),
    ('Bob Martin', 'bob@example.com', 'US'),
    ('Claire Moreau', 'claire@example.com', 'FR'),
    ('David Wilson', 'david@example.com', 'US'),
    ('Eva Schmidt', 'eva@example.com', 'DE')
  `);
  
  await connection.execute(`
    INSERT INTO orders (customer_id, product_id, quantity, total, status) VALUES
    (1, 1, 2, 300.00, 'completed'),
    (1, 2, 1, 75.00, 'completed'),
    (2, 3, 5, 250.00, 'shipped'),
    (3, 4, 1, 200.00, 'pending'),
    (4, 1, 3, 450.00, 'completed'),
    (5, 2, 2, 150.00, 'pending')
  `);
  
  const [prodCount] = await connection.execute('SELECT COUNT(*) as cnt FROM products');
  const [custCount] = await connection.execute('SELECT COUNT(*) as cnt FROM customers');
  const [orderCount] = await connection.execute('SELECT COUNT(*) as cnt FROM orders');
  console.log(`  Products: ${prodCount[0].cnt}, Customers: ${custCount[0].cnt}, Orders: ${orderCount[0].cnt}`);
  
  console.log('\n🔍 Running queries:');
  
  const [products] = await connection.execute('SELECT * FROM products');
  console.log(`\n  Products (${products.length}):`);
  for (const p of products) {
    console.log(`    ${p.name} — ${p.category} — $${p.price} (stock: ${p.stock})`);
  }
  
  const [orders] = await connection.execute(`
    SELECT o.id, c.name as customer, p.name as product, o.quantity, o.total, o.status
    FROM orders o
    JOIN customers c ON o.customer_id = c.id
    JOIN products p ON o.product_id = p.id
    ORDER BY o.created_at DESC
  `);
  console.log(`\n  Orders with details (${orders.length}):`);
  for (const o of orders) {
    console.log(`    #${o.id}: ${o.customer} → ${o.product} ×${o.quantity} = $${o.total} [${o.status}]`);
  }
  
  const [revenue] = await connection.execute(`
    SELECT c.country, COUNT(o.id) as order_count, SUM(o.total) as total_revenue
    FROM orders o
    JOIN customers c ON o.customer_id = c.id
    GROUP BY c.country
    ORDER BY total_revenue DESC
  `);
  console.log(`\n  Revenue by country:`);
  for (const r of revenue) {
    console.log(`    ${r.country}: ${r.order_count} orders, $${r.total_revenue}`);
  }
  
  const [topProducts] = await connection.execute(`
    SELECT p.name, SUM(o.quantity) as qty_sold, SUM(o.total) as revenue
    FROM orders o
    JOIN products p ON o.product_id = p.id
    GROUP BY p.id, p.name
    ORDER BY revenue DESC
    LIMIT 3
  `);
  console.log(`\n  Top 3 products:`);
  for (const p of topProducts) {
    console.log(`    ${p.name}: ${p.qty_sold} sold, $${p.revenue} revenue`);
  }
  
  await connection.end();
  console.log('\n✅ MySQL happy path OK');
}

main().catch(e => {
  console.error('❌ MySQL happy path FAILED:', e.message);
  process.exit(1);
});
