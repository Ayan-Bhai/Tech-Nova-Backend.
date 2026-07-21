-- ============================================================
-- TechNova — Supabase Postgres schema (full, v10)
-- Run this ONCE in Supabase: SQL Editor → New query → paste → Run
-- (or: npm run db:init  with DATABASE_URL set)
-- ============================================================

-- Users
CREATE TABLE IF NOT EXISTS users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer',   -- 'customer' | 'admin' | 'owner'
  verified INTEGER NOT NULL DEFAULT 0,
  verify_code TEXT,
  verify_expires BIGINT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Sessions (bearer tokens)
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Categories
CREATE TABLE IF NOT EXISTS categories (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

-- Products
CREATE TABLE IF NOT EXISTS products (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  category_id BIGINT REFERENCES categories(id) ON DELETE SET NULL,
  price INTEGER NOT NULL DEFAULT 0,        -- PKR
  old_price INTEGER,
  badge TEXT,
  icon TEXT DEFAULT 'laptop',
  descr TEXT,
  stock INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_products_cat ON products(category_id);

-- Orders
CREATE TABLE IF NOT EXISTS orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  code TEXT NOT NULL,
  items TEXT NOT NULL,                     -- JSON [{product_id,name,price,qty}]
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | confirmed | delivered | cancelled
  discount INTEGER NOT NULL DEFAULT 0,
  coupon TEXT,
  pay_method TEXT NOT NULL DEFAULT 'whatsapp',  -- whatsapp | card
  pay_status TEXT NOT NULL DEFAULT 'unpaid',    -- unpaid | paid
  pay_session TEXT,                             -- stripe checkout session id
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);

-- Contact messages
CREATE TABLE IF NOT EXISTS messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  body TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Site settings (key-value: gmail, stripe, branding, SEO, logo, services…)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Product images (base64, served via /img/:id)
CREATE TABLE IF NOT EXISTS product_images (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  mime TEXT NOT NULL DEFAULT 'image/jpeg',
  data TEXT NOT NULL,
  sort INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pimg_product ON product_images(product_id);

-- Coupons
CREATE TABLE IF NOT EXISTS coupons (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,               -- stored uppercase
  percent INTEGER NOT NULL,                -- 1..90
  min_total INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER NOT NULL DEFAULT 0,     -- 0 = unlimited
  uses INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  expires_at TIMESTAMPTZ,                  -- NULL = never
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- SEED DATA (safe to re-run: ON CONFLICT DO NOTHING)
-- Default admin: admin@technova.pk / TN-ADMIN-2949  (role=owner)
-- ============================================================
INSERT INTO users (email, name, pass_hash, salt, role, verified) VALUES
  ('admin@technova.pk', 'Admin', '794a38aa3a4db06eb590a2f73e27f1b279a5ce2dc017078ef8a438ed00193e60', 'a1b2c3d4e5f60718', 'owner', 1)
ON CONFLICT (email) DO NOTHING;

INSERT INTO categories (name, sort) VALUES
  ('Laptops', 1), ('Mobiles', 2), ('Audio', 3), ('Accessories', 4), ('Components', 5)
ON CONFLICT (name) DO NOTHING;

INSERT INTO products (name, category_id, price, old_price, badge, icon, descr, stock, pinned, sort)
SELECT * FROM (VALUES
  ('HP EliteBook 840 G8',      (SELECT id FROM categories WHERE name='Laptops'),     145000, 165000, 'Hot',     'laptop',     'i5 11th Gen · 16GB · 512GB SSD',            6, 1, 1),
  ('Dell Latitude 7420',       (SELECT id FROM categories WHERE name='Laptops'),     132000, NULL,   NULL,      'laptop',     'i7 11th Gen · 16GB · 256GB SSD',            4, 0, 2),
  ('MacBook Air M1',           (SELECT id FROM categories WHERE name='Laptops'),     235000, NULL,   'Premium', 'laptop',     '8GB · 256GB · Space Gray',                  3, 0, 3),
  ('Samsung Galaxy A55',       (SELECT id FROM categories WHERE name='Mobiles'),     118000, NULL,   NULL,      'phone',      '8GB · 256GB · PTA Approved',                8, 0, 4),
  ('iPhone 13',                (SELECT id FROM categories WHERE name='Mobiles'),     195000, NULL,   'Hot',     'phone',      '128GB · Non-Active · Factory Sealed',       2, 1, 5),
  ('Redmi Note 13 Pro',        (SELECT id FROM categories WHERE name='Mobiles'),      74500, 82000,  NULL,      'phone',      '12GB · 256GB · PTA Approved',              10, 0, 6),
  ('AirPods Pro 2',            (SELECT id FROM categories WHERE name='Audio'),        62000, NULL,   NULL,      'earbuds',    'ANC · USB-C · 1 Year Warranty',             7, 0, 7),
  ('JBL Flip 6',               (SELECT id FROM categories WHERE name='Audio'),        32500, NULL,   NULL,      'speaker',    'Portable · Waterproof · 12h Battery',       5, 0, 8),
  ('Sony WH-CH520',            (SELECT id FROM categories WHERE name='Audio'),        18500, NULL,   NULL,      'headphones', 'Wireless · 50h Battery',                    9, 0, 9),
  ('Anker 65W GaN Charger',    (SELECT id FROM categories WHERE name='Accessories'),   8900, NULL,   'New',     'charger',    'Fast Charge · Dual USB-C',                 15, 0, 10),
  ('Logitech MX Master 3S',    (SELECT id FROM categories WHERE name='Accessories'),  27000, NULL,   NULL,      'mouse',      'Wireless · Silent Clicks · 8K DPI',         6, 0, 11),
  ('Mechanical Keyboard K68',  (SELECT id FROM categories WHERE name='Accessories'),  12500, NULL,   NULL,      'keyboard',   'RGB · Blue Switches · Hot-Swap',            8, 0, 12),
  ('16GB DDR4 3200MHz RAM',    (SELECT id FROM categories WHERE name='Components'),    9800, 11500,  NULL,      'ram',        'CL16 · Desktop UDIMM',                     20, 0, 13),
  ('RTX 3060 12GB',            (SELECT id FROM categories WHERE name='Components'),   92000, NULL,   'Hot',     'gpu',        'Used · Tested · 1 Month Check Warranty',    2, 0, 14),
  ('24" IPS LED Monitor',      (SELECT id FROM categories WHERE name='Components'),   28500, NULL,   NULL,      'monitor',    '1080p · 75Hz · HDMI + VGA',                 4, 0, 15)
) AS v(name, category_id, price, old_price, badge, icon, descr, stock, pinned, sort)
WHERE NOT EXISTS (SELECT 1 FROM products);
