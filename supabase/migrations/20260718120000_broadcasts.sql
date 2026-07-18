-- Broadcast module: campaigns + per-recipient delivery queue

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

CREATE INDEX idx_broadcast_recipients_pending
  ON public.broadcast_recipients (broadcast_id, status)
  WHERE status = 'pending';

CREATE INDEX idx_broadcasts_active
  ON public.broadcasts (status)
  WHERE status IN ('queued', 'sending');

GRANT ALL ON public.broadcasts TO service_role;
GRANT ALL ON public.broadcast_recipients TO service_role;
ALTER TABLE public.broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broadcast_recipients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service Role All broadcasts" ON public.broadcasts;
CREATE POLICY "Service Role All broadcasts"
ON public.broadcasts FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service Role All broadcast_recipients" ON public.broadcast_recipients;
CREATE POLICY "Service Role All broadcast_recipients"
ON public.broadcast_recipients FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'broadcast-images',
  'broadcast-images',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp']
) ON CONFLICT (id) DO NOTHING;
