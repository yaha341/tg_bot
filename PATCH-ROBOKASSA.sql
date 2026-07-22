-- Патч: Robokassa + юридические документы (текст + файлы оферты/политики)
-- Выполните в SQL Editor Supabase на уже существующей БД

INSERT INTO public.app_settings (key, value) VALUES
('robokassa_enabled', 'false'),
('robokassa_test_mode', 'false'),
('robokassa_login', ''),
('robokassa_pass1', ''),
('robokassa_pass2', ''),
('robokassa_pass1_test', ''),
('robokassa_pass2_test', ''),
('legal_seller_details', 'ИП / ТОО «Название»\nБИН: 000000000000\nБанк: …\nИИК: …\nАдрес: …\n\n(Замените на свои реквизиты в админке → Настройки)'),
('legal_offer_html', ''),
('legal_privacy_html', ''),
('legal_about_html', '<h1>О продавце</h1><p>Краткое описание автора / продавца материалов.</p><p><strong>Замените этот текст</strong> в админке → Настройки.</p>'),
('legal_offer_file', ''),
('legal_offer_filename', ''),
('legal_privacy_file', ''),
('legal_privacy_filename', '')
ON CONFLICT (key) DO NOTHING;

-- Bucket для PDF/DOC оферты и политики
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'legal-docs',
  'legal-docs',
  true,
  20971520,
  ARRAY[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/octet-stream'
  ]
) ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Public Read legal-docs" ON storage.objects;
CREATE POLICY "Public Read legal-docs"
ON storage.objects FOR SELECT TO public
USING (bucket_id = 'legal-docs');
