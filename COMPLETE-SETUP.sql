-- === ПОЛНАЯ НАСТРОЙКА SUPABASE ДЛЯ TELEGRAM БОТА ===
-- Выполните этот скрипт по частям в SQL Editor Supabase
-- https://supabase.com/dashboard/project/fnwksbasxakktscdjlfp/sql

-- ============================================
-- ЧАСТЬ 1: Создание таблиц базы данных
-- ============================================

-- Categories with nesting
CREATE TABLE public.categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  parent_id UUID REFERENCES public.categories(id) ON DELETE CASCADE,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.categories TO service_role;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;

-- Products
CREATE TABLE public.products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID REFERENCES public.categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  keywords TEXT NOT NULL DEFAULT '',
  price NUMERIC(10,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'KZT',
  file_path TEXT,
  file_name TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.products TO service_role;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_products_category ON public.products(category_id);
CREATE INDEX idx_products_search ON public.products USING gin (to_tsvector('simple', name || ' ' || coalesce(description,'') || ' ' || coalesce(keywords,'')));

-- Product images
CREATE TABLE public.product_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  image_path TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.product_images TO service_role;
ALTER TABLE public.product_images ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_product_images_product ON public.product_images(product_id);

-- Payment methods by country
CREATE TABLE public.payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code TEXT NOT NULL,
  country_name TEXT NOT NULL,
  instructions TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.payment_methods TO service_role;
ALTER TABLE public.payment_methods ENABLE ROW LEVEL SECURITY;

-- Bot users (telegram users)
CREATE TABLE public.bot_users (
  telegram_id BIGINT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  language_code TEXT,
  contact_phone TEXT,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.bot_users TO service_role;
ALTER TABLE public.bot_users ENABLE ROW LEVEL SECURITY;

-- Cart items
CREATE TABLE public.cart_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT NOT NULL REFERENCES public.bot_users(telegram_id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  quantity INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(telegram_id, product_id)
);
GRANT ALL ON public.cart_items TO service_role;
ALTER TABLE public.cart_items ENABLE ROW LEVEL SECURITY;

-- Orders
CREATE TABLE public.orders (
  id BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL REFERENCES public.bot_users(telegram_id),
  username TEXT,
  display_name TEXT,
  contact TEXT,
  country_code TEXT,
  country_name TEXT,
  total NUMERIC(10,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'KZT',
  status TEXT NOT NULL DEFAULT 'awaiting_payment',
  payment_proof_path TEXT,
  admin_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.orders TO service_role;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_orders_telegram ON public.orders(telegram_id);
CREATE INDEX idx_orders_status ON public.orders(status);

-- Order items
CREATE TABLE public.order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id BIGINT NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  name_snapshot TEXT NOT NULL,
  price_snapshot NUMERIC(10,2) NOT NULL,
  quantity INT NOT NULL DEFAULT 1,
  file_path_snapshot TEXT,
  file_name_snapshot TEXT,
  delivered_language TEXT
);
GRANT ALL ON public.order_items TO service_role;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_order_items_order ON public.order_items(order_id);
COMMENT ON COLUMN public.order_items.delivered_language IS 'Tracks which language variant was delivered: NULL (not delivered), ru, kz, or both';

-- Broadcasts (mass-messaging campaigns)
CREATE TABLE public.broadcasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'completed', 'cancelled', 'failed')),
  message_text TEXT NOT NULL,
  photo_paths JSONB NOT NULL DEFAULT '[]'::jsonb,
  product_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  show_catalog BOOLEAN NOT NULL DEFAULT true,
  audience_type TEXT NOT NULL DEFAULT 'all'
    CHECK (audience_type IN ('all', 'country', 'buyers', 'non_buyers', 'test')),
  audience_filter JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_count INT NOT NULL DEFAULT 0,
  sent_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  blocked_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
GRANT ALL ON public.broadcasts TO service_role;
ALTER TABLE public.broadcasts ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_broadcasts_active ON public.broadcasts (status) WHERE status IN ('queued', 'sending');

-- Broadcast recipients (per-user delivery queue)
CREATE TABLE public.broadcast_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id UUID NOT NULL REFERENCES public.broadcasts(id) ON DELETE CASCADE,
  telegram_id BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'blocked')),
  error_message TEXT,
  sent_at TIMESTAMPTZ,
  UNIQUE (broadcast_id, telegram_id)
);
GRANT ALL ON public.broadcast_recipients TO service_role;
ALTER TABLE public.broadcast_recipients ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_broadcast_recipients_pending ON public.broadcast_recipients (broadcast_id, status) WHERE status = 'pending';

-- App settings (kv)
CREATE TABLE public.app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.app_settings TO service_role;
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER trg_bot_users_touch BEFORE UPDATE ON public.bot_users
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_orders_touch BEFORE UPDATE ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Seed default payment methods
INSERT INTO public.payment_methods (country_code, country_name, instructions, sort_order) VALUES
('KZ', '🇰🇿 Казахстан', 'Kaspi / Halyk\n\nПереведите сумму на номер: +7 XXX XXX XX XX\nПолучатель: Имя Фамилия\n\nПосле оплаты пришлите скриншот в этот чат.', 1),
('RU', '🇷🇺 Россия', 'Сбербанк / Тинькофф\n\nНомер карты: 0000 0000 0000 0000\nПолучатель: Имя Фамилия\n\nПосле оплаты пришлите скриншот в этот чат.', 2),
('KG', '🇰🇬 Кыргызстан', 'MBank / Optima\n\nНомер: +996 XXX XXX XXX\n\nПосле оплаты пришлите скриншот в этот чат.', 3),
('BY', '🇧🇾 Беларусь', 'Реквизиты:\n\nНомер карты: 0000 0000 0000 0000\n\nПосле оплаты пришлите скриншот в этот чат.', 4),
('OTHER', '🌍 Другая страна', 'Свяжитесь с продавцом для уточнения реквизитов оплаты.', 99);

-- Добавление валюты в payment_methods
ALTER TABLE public.payment_methods ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'KZT';
UPDATE public.payment_methods SET currency = CASE country_code
  WHEN 'KZ' THEN 'KZT'
  WHEN 'RU' THEN 'RUB'
  WHEN 'KG' THEN 'KGS'
  WHEN 'BY' THEN 'BYN'
  ELSE 'USD'
END WHERE currency = 'KZT' OR currency IS NULL;

-- ============================================
-- ЧАСТЬ 2: Создание Storage Buckets
-- ============================================

-- Создание bucket для изображений товаров
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'product-images',
  'product-images',
  true,
  5242880, -- 5MB limit
  ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp']
) ON CONFLICT (id) DO NOTHING;

-- Создание bucket для файлов товаров
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'product-files',
  'product-files',
  true,
  52428800, -- 50MB limit
  ARRAY['application/pdf', 'application/zip', 'application/x-rar-compressed', 'application/x-7z-compressed', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
) ON CONFLICT (id) DO NOTHING;

-- Создание bucket для изображений рассылки
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'broadcast-images',
  'broadcast-images',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp']
) ON CONFLICT (id) DO NOTHING;

-- Создание bucket для скриншотов оплаты
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'payment-proofs',
  'payment-proofs',
  false, -- приватный
  5242880, -- 5MB limit
  ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp']
) ON CONFLICT (id) DO NOTHING;

-- ============================================
-- ЧАСТЬ 3: RLS Policies для Storage
-- ============================================

-- Политики для product-images (публичный доступ на чтение)
DROP POLICY IF EXISTS "Public Read product-images" ON storage.objects;
CREATE POLICY "Public Read product-images"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'product-images');

-- Политики для product-files (публичный доступ на чтение)
DROP POLICY IF EXISTS "Public Read product-files" ON storage.objects;
CREATE POLICY "Public Read product-files"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'product-files');

-- Политики для payment-proofs (только сервисный роль)
DROP POLICY IF EXISTS "Service Role All payment-proofs" ON storage.objects;
CREATE POLICY "Service Role All payment-proofs"
ON storage.objects FOR ALL
TO service_role
USING (bucket_id = 'payment-proofs')
WITH CHECK (bucket_id = 'payment-proofs');

-- ============================================
-- ЧАСТЬ 4: RLS Policies для таблиц
-- ============================================

-- Categories
DROP POLICY IF EXISTS "Service Role All categories" ON public.categories;
CREATE POLICY "Service Role All categories"
ON public.categories FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Products
DROP POLICY IF EXISTS "Service Role All products" ON public.products;
CREATE POLICY "Service Role All products"
ON public.products FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Product images
DROP POLICY IF EXISTS "Service Role All product_images" ON public.product_images;
CREATE POLICY "Service Role All product_images"
ON public.product_images FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Payment methods
DROP POLICY IF EXISTS "Service Role All payment_methods" ON public.payment_methods;
CREATE POLICY "Service Role All payment_methods"
ON public.payment_methods FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Bot users
DROP POLICY IF EXISTS "Service Role All bot_users" ON public.bot_users;
CREATE POLICY "Service Role All bot_users"
ON public.bot_users FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Cart items
DROP POLICY IF EXISTS "Service Role All cart_items" ON public.cart_items;
CREATE POLICY "Service Role All cart_items"
ON public.cart_items FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Orders
DROP POLICY IF EXISTS "Service Role All orders" ON public.orders;
CREATE POLICY "Service Role All orders"
ON public.orders FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Order items
DROP POLICY IF EXISTS "Service Role All order_items" ON public.order_items;
CREATE POLICY "Service Role All order_items"
ON public.order_items FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Broadcasts
DROP POLICY IF EXISTS "Service Role All broadcasts" ON public.broadcasts;
CREATE POLICY "Service Role All broadcasts"
ON public.broadcasts FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Broadcast recipients
DROP POLICY IF EXISTS "Service Role All broadcast_recipients" ON public.broadcast_recipients;
CREATE POLICY "Service Role All broadcast_recipients"
ON public.broadcast_recipients FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- App settings
DROP POLICY IF EXISTS "Service Role All app_settings" ON public.app_settings;
CREATE POLICY "Service Role All app_settings"
ON public.app_settings FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Public read for broadcast-images bucket
DROP POLICY IF EXISTS "Public Read broadcast-images" ON storage.objects;
CREATE POLICY "Public Read broadcast-images"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'broadcast-images');