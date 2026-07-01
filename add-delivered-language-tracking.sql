-- Add column to track which language variant was delivered for each order item
ALTER TABLE public.order_items
ADD COLUMN IF NOT EXISTS delivered_language TEXT;

-- delivered_language can be: NULL (not delivered), 'ru', 'kz', or 'both'
COMMENT ON COLUMN public.order_items.delivered_language IS 'Tracks which language variant was delivered: NULL (not delivered), ru, kz, or both';
