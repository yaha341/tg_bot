-- Tenant module matrix for the unified repository.
-- This migration is intentionally additive: it preserves unknown module keys and
-- only sets capabilities that are part of the current consolidation contract.
-- Apply to the shared Supabase project only after the unified code is deployed
-- to a staging Vercel project and the tenant smoke tests pass.

DO $$
DECLARE
  expected_count integer;
BEGIN
  SELECT count(*) INTO expected_count
  FROM public.bots
  WHERE id IN (
    '0bac1f86-5231-4e57-838d-2faa44d427e7'::uuid,
    'de44b934-c8db-47ac-9aa9-535c762cf8c7'::uuid,
    '89d155d1-91e1-4c2d-981e-43741a0badc3'::uuid,
    '19ce949b-8877-4fa7-b072-c09980eb7ee3'::uuid,
    'd6331748-52e2-4b88-af41-ccd545f789a8'::uuid
  );

  IF expected_count <> 5 THEN
    RAISE EXCEPTION
      'Tenant module matrix expected 5 bot rows, found %; refusing partial update',
      expected_count;
  END IF;
END
$$;

-- Anastasia: all functionality present in tg_bot is paid and active.
UPDATE public.bots
SET modules = COALESCE(modules, '{}'::jsonb) || jsonb_build_object(
  'shop', true,
  'vip', false,
  'instagram', true,
  'broadcasts', true,
  'robokassa', true,
  'receipt_ocr', true,
  'blocked_users', false,
  'multi_file_materials', false
)
WHERE id = '0bac1f86-5231-4e57-838d-2faa44d427e7'::uuid;

-- Saltanat: VIP, Instagram/Zernio and blocked users are not part of the plan.
-- Multi-file materials are active and paid for this client.
UPDATE public.bots
SET modules = COALESCE(modules, '{}'::jsonb) || jsonb_build_object(
  'shop', true,
  'vip', false,
  'instagram', false,
  'broadcasts', false,
  'robokassa', false,
  'receipt_ocr', false,
  'blocked_users', false,
  'multi_file_materials', true
)
WHERE id = 'de44b934-c8db-47ac-9aa9-535c762cf8c7'::uuid;

-- Print KZ: VIP, Instagram/Zernio and blocked users are not part of the plan.
UPDATE public.bots
SET modules = COALESCE(modules, '{}'::jsonb) || jsonb_build_object(
  'shop', true,
  'vip', false,
  'instagram', false,
  'broadcasts', false,
  'robokassa', false,
  'receipt_ocr', false,
  'blocked_users', false,
  'multi_file_materials', false
)
WHERE id = '89d155d1-91e1-4c2d-981e-43741a0badc3'::uuid;

-- Didactica: VIP and blocked-users exist in the source project; Instagram and
-- the Anastasia-only broadcast/Robokassa/OCR modules do not.
UPDATE public.bots
SET modules = COALESCE(modules, '{}'::jsonb) || jsonb_build_object(
  'shop', true,
  'vip', true,
  'instagram', false,
  'broadcasts', false,
  'robokassa', false,
  'receipt_ocr', false,
  'blocked_users', true,
  'multi_file_materials', false
)
WHERE id = '19ce949b-8877-4fa7-b072-c09980eb7ee3'::uuid;

-- Razvivashka: VIP, Instagram/Zernio and blocked-users exist in the source
-- project; broadcasts/Robokassa/OCR are Anastasia-only modules.
UPDATE public.bots
SET modules = COALESCE(modules, '{}'::jsonb) || jsonb_build_object(
  'shop', true,
  'vip', true,
  'instagram', true,
  'broadcasts', false,
  'robokassa', false,
  'receipt_ocr', false,
  'blocked_users', true,
  'multi_file_materials', false
)
WHERE id = 'd6331748-52e2-4b88-af41-ccd545f789a8'::uuid;
