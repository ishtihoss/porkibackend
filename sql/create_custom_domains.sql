-- Custom domains table for in-app domain purchase feature
-- Run this in Supabase SQL Editor

CREATE TABLE custom_domains (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  subdomain TEXT NOT NULL,                    -- FK to published_sites.subdomain
  domain TEXT NOT NULL UNIQUE,                -- e.g. 'mysite.com'
  status TEXT NOT NULL DEFAULT 'payment_pending',
  -- Statuses: payment_pending | registering | configuring_dns | issuing_cert
  --           | deploying_cdn | active | renewal_due | expired | transfer_out

  -- Porkbun
  porkbun_domain_id TEXT,

  -- AWS
  route53_hosted_zone_id TEXT,
  route53_nameservers TEXT[],
  acm_certificate_arn TEXT,
  cloudfront_distribution_id TEXT,
  cloudfront_domain_name TEXT,

  -- Stripe
  stripe_checkout_session_id TEXT,
  stripe_subscription_id TEXT,

  -- Pricing
  purchase_price_cents INTEGER,
  renewal_price_cents INTEGER,

  -- Dates
  domain_registered_at TIMESTAMPTZ,
  domain_expires_at TIMESTAMPTZ,
  cert_issued_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_custom_domains_user ON custom_domains(user_id);
CREATE INDEX idx_custom_domains_domain ON custom_domains(domain);
CREATE INDEX idx_custom_domains_subdomain ON custom_domains(subdomain);
CREATE INDEX idx_custom_domains_status ON custom_domains(status);

-- RLS policies (service role bypasses, but good practice)
ALTER TABLE custom_domains ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own domains"
  ON custom_domains FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access"
  ON custom_domains FOR ALL
  USING (true)
  WITH CHECK (true);
