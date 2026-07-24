-- Скрытие сезонных категорий в каталоге бота (без удаления).
-- Выполните в Supabase → SQL Editor.

ALTER TABLE public.categories
  ADD COLUMN IF NOT EXISTS is_visible BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.categories.is_visible IS
  'false = скрыта из каталога бота; товары и файлы остаются.';

-- Bucket для видео-инструкции (до ~50 МБ — лимит облачного Telegram Bot API)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'instruction-videos',
  'instruction-videos',
  true,
  52428800,
  ARRAY['video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo']
) ON CONFLICT (id) DO UPDATE
SET file_size_limit = EXCLUDED.file_size_limit;

DROP POLICY IF EXISTS "Public Read instruction-videos" ON storage.objects;
CREATE POLICY "Public Read instruction-videos"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'instruction-videos');

DROP POLICY IF EXISTS "Service Role All instruction-videos" ON storage.objects;
CREATE POLICY "Service Role All instruction-videos"
ON storage.objects FOR ALL
TO service_role
USING (bucket_id = 'instruction-videos')
WITH CHECK (bucket_id = 'instruction-videos');

INSERT INTO public.app_settings (key, value) VALUES
  ('instruction_video_path', ''),
  ('instruction_video_file_id', ''),
  ('instruction_caption',
   '📖 Как пользоваться ботом:
1. Откройте «Каталог» или «Поиск» и выберите материалы.
2. Добавьте товары в корзину и оформите заказ.
3. Оплатите по инструкции и пришлите чек (или оплатите через Robokassa, если доступна кнопка).
4. После подтверждения оплаты файлы придут в этот чат.

Если что-то непонятно — напишите через «Связаться с автором».')
ON CONFLICT (key) DO NOTHING;

NOTIFY pgrst, 'reload schema';
