-- Прогресс порционной выдачи файлов (большие заказы не зависают на Vercel timeout)
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS delivery_index INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.orders.delivery_index IS
  'Сколько позиций order_items уже отправлено покупателю (0..N). При status=delivering cron продолжает с этого индекса.';

NOTIFY pgrst, 'reload schema';
