ALTER TABLE public.payment_methods ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'KZT';
UPDATE public.payment_methods SET currency = CASE country_code
  WHEN 'KZ' THEN 'KZT'
  WHEN 'RU' THEN 'RUB'
  WHEN 'KG' THEN 'KGS'
  WHEN 'BY' THEN 'BYN'
  ELSE 'USD'
END WHERE currency = 'KZT' OR currency IS NULL;