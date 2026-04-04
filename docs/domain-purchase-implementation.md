# In-App Domain Purchase — Implementation Status

## Overview

Feature that lets non-technical users buy a custom domain (e.g., `mysite.com`) directly inside PorkiCoder and have it automatically configured — no DNS records, no registrar accounts, no technical steps.

**Stack:** Porkbun (domain registration, reseller API) + AWS (Route 53 for DNS, ACM for SSL, CloudFront for CDN) + Stripe (payments, already integrated)

**Architecture:**
```
User clicks "Buy Domain" in app
  → Stripe Checkout (payment)
  → Porkbun API (register domain under our reseller account)
  → Porkbun API (set nameservers to Route 53)
  → Route 53 (create hosted zone + A record → CloudFront)
  → ACM (request SSL cert, DNS-validated via Route 53)
  → CloudFront (distribution with ACM cert, origin = Supabase Storage)
  → Site live at https://mysite.com (~5 min)
```

CloudFront points directly to Supabase Storage — no EC2/nginx in the path for custom domains. Zero nginx config changes needed.

---

## What's Done

### Database
- [x] `custom_domains` table created in Supabase (migration ran successfully)
- [x] Indexes on user_id, domain, subdomain, status
- [x] RLS policies configured
- [x] Migration file: `sql/create_custom_domains.sql`

### Backend Services (porkibackend)

- [x] **`src/services/DomainSearchService.js`** — Porkbun availability + pricing search with 5-min cache, TLD suggestions, markup pricing
- [x] **`src/services/DomainPurchaseService.js`** — Porkbun domain registration, nameserver management, renewals, transfer-out (unlock + auth code)
- [x] **`src/services/DomainInfraService.js`** — AWS SDK integration:
  - Route 53: create/delete hosted zones, add DNS records (including CloudFront alias records)
  - ACM: request certs with DNS validation, poll status, get validation records
  - CloudFront: create/update/delete distributions, cache invalidation, origin path updates
- [x] **`src/services/DomainOrchestrator.js`** — State machine coordinating the full provisioning pipeline (payment_pending → registering → configuring_dns → issuing_cert → deploying_cdn → active). Idempotent/retryable steps, SSE progress events.

### Backend API Endpoints (porkibackend)

- [x] `POST /api/domains/search` — Search domain availability + pricing
- [x] `POST /api/domains/purchase` — Create Stripe checkout session for domain purchase
- [x] `GET /api/domains/status/:domainId` — SSE stream for real-time provisioning progress
- [x] `GET /api/domains/list/:userId` — List user's custom domains
- [x] `DELETE /api/domains/:userId/:domain` — Delete domain + tear down AWS infrastructure
- [x] `POST /api/domains/transfer/:domain` — Initiate domain transfer out
- [x] `POST /api/domains/change-site/:domain` — Re-point domain to different published site

### Stripe Integration (porkibackend)

- [x] `createDomainCheckoutSession()` in StripeService — one-time payment with dynamic pricing
- [x] Webhook handler extended: `checkout.session.completed` with `type: 'domain_purchase'` triggers provisioning
- [x] Uses existing customer management and webhook signature verification

### NPM Dependencies (porkibackend)

- [x] `@aws-sdk/client-route-53` installed
- [x] `@aws-sdk/client-acm` installed
- [x] `@aws-sdk/client-cloudfront` installed

### Electron Client (porkr1)

- [x] **`src/main/services/domainService.js`** — API client for all domain endpoints (search, purchase, list, delete, transfer, change-site)
- [x] **`src/renderer/components/Publish/DomainPurchaseModal.js`** — 5-state modal:
  1. Search — domain name input + search button
  2. Results — availability list with prices + Buy buttons
  3. Checkout — opens Stripe in browser
  4. Provisioning — real-time step-by-step progress (polls domain status)
  5. Complete — live URL + renewal info
- [x] **`src/renderer/styles/domain-purchase.css`** — Dark theme styling matching publish.css patterns
- [x] **`src/main/preload.js`** — 7 new IPC channels (`domain:search`, `domain:purchase`, `domain:list`, `domain:delete`, `domain:transfer`, `domain:change-site`, `domain:status-url`)
- [x] **`src/main/index.js`** — 7 new `registerSecureHandler` IPC handlers
- [x] **`src/renderer/renderer.js`** — DomainPurchaseModal imported and instantiated
- [x] **`src/renderer/index.html`** — `domain-purchase.css` linked
- [x] **`src/renderer/components/Publish/PublishModal.js`** — "Get Custom Domain" button added in complete state
- [x] **`src/renderer/styles/publish.css`** — `.publish-btn-domain` styling

---

## What's Missing (pick up next session)

### Credentials Needed

1. **Porkbun Reseller API Key** — Apply for reseller account at porkbun.com, get API key + secret key
   - Add to porkibackend `.env`:
     ```
     PORKBUN_API_KEY=pk1_...
     PORKBUN_SECRET_KEY=sk1_...
     ```

2. **AWS IAM Credentials** — Create an IAM user with programmatic access
   - Required policies: `AmazonRoute53FullAccess`, `AWSCertificateManagerFullAccess`, `CloudFrontFullAccess`
   - Add to porkibackend `.env`:
     ```
     AWS_ACCESS_KEY_ID=AKIA...
     AWS_SECRET_ACCESS_KEY=...
     AWS_REGION=us-east-1
     ```

3. **Domain markup percentage** (optional, defaults to 20%):
   ```
   DOMAIN_MARKUP_PERCENT=20
   ```

### Features Still To Build

- [ ] **Domain renewal cron job** — Daily check for domains expiring within 30 days, charge Stripe subscription, renew at Porkbun
- [ ] **Settings UI integration** — Show custom domains in Settings → Published Sites with manage/renew/transfer/delete actions
- [ ] **Stripe success/cancel URL handling** — The Electron app needs to handle the redirect after Stripe checkout (currently points to frontend URLs that don't exist in the Electron app)
- [ ] **End-to-end testing** — Buy a cheap test domain ($2-3 TLD) to verify the full pipeline
- [ ] **Error recovery** — Handle edge cases: Porkbun API down, AWS rate limits, partial provisioning failures
- [ ] **Domain renewal Stripe subscriptions** — After initial purchase, create annual subscription per domain

### Deployment

- [ ] Add new env vars to production `.env` on EC2
- [ ] Rebuild and push Docker image for porkibackend
- [ ] Test with a real domain purchase

---

## File Reference

### Backend (porkibackend)
| File | Purpose |
|------|---------|
| `sql/create_custom_domains.sql` | Database migration (already ran) |
| `src/services/DomainSearchService.js` | Porkbun availability + pricing |
| `src/services/DomainPurchaseService.js` | Porkbun registration + management |
| `src/services/DomainInfraService.js` | AWS Route 53, ACM, CloudFront |
| `src/services/DomainOrchestrator.js` | Provisioning state machine |
| `src/services/StripeService.js` | Extended with domain checkout + webhook |
| `src/index.js` | Extended with 7 domain API endpoints |

### Electron Client (porkr1)
| File | Purpose |
|------|---------|
| `src/main/services/domainService.js` | API client for domain endpoints |
| `src/renderer/components/Publish/DomainPurchaseModal.js` | 5-state purchase modal |
| `src/renderer/styles/domain-purchase.css` | Modal styling |
| `src/main/preload.js` | IPC channel definitions + bridge methods |
| `src/main/index.js` | IPC handler registration |
| `src/renderer/renderer.js` | Modal instantiation |
| `src/renderer/components/Publish/PublishModal.js` | "Get Custom Domain" button |

---

## Cost Estimates (per domain)

| Component | Cost |
|-----------|------|
| Route 53 hosted zone | $0.50/month |
| Route 53 queries | ~$0.00 (negligible) |
| ACM certificates | Free |
| CloudFront | First 1TB/month free |
| Porkbun .com registration | ~$9.73/year wholesale |
| **User pays** | Wholesale + 20% markup |
