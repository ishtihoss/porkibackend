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

### Remaining Work

#### 1. Deploy to EC2 and End-to-End Test
- [ ] Copy updated `.env` to EC2 (with PORKBUN_API_KEY, PORKBUN_SECRET_KEY, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION)
- [ ] `git pull` on EC2, rebuild Docker image, restart container
- [ ] Buy a cheap test domain (~$2 `.xyz`) through the full pipeline
- [ ] Verify: Stripe charge → Porkbun registration → Route 53 zone → ACM cert → CloudFront distribution → site loads on custom domain with HTTPS

#### 2. Stripe Checkout Redirect Handling
- [ ] The `success_url` and `cancel_url` in `StripeService.createDomainCheckoutSession()` currently point to `https://porkicoder.com/domain-success` and `domain-cancel` — these pages don't exist
- [ ] **Option A**: Create simple success/cancel pages on the landing site that tell the user to go back to the app
- [ ] **Option B**: Use a custom protocol handler (`porkicoder://domain-success?domain=...`) so the Electron app catches the redirect directly
- [ ] Either way, the DomainPurchaseModal already polls for status, so the user just needs to know to go back to the app

#### 3. Settings UI — Domain Management
- [ ] In `SettingsModal.js` → Published Sites section, show custom domains alongside published sites
- [ ] Each domain row shows: domain name, status badge (active/provisioning/expired), linked subdomain, expiry date
- [ ] Action buttons per domain:
  - **Change Site** — dropdown of user's published sites, calls `domain:change-site`
  - **Transfer Out** — shows auth/EPP code, calls `domain:transfer`
  - **Delete** — confirmation dialog, calls `domain:delete`
- [ ] "Add Domain" button next to any published site that doesn't have one (opens DomainPurchaseModal)

#### 4. Domain Renewal System
- [ ] **Backend cron job** (`src/services/DomainRenewalService.js`):
  - Runs daily (use `setInterval` or a proper cron lib like `node-cron`)
  - Queries `custom_domains` where `domain_expires_at` is within 30 days and status is `active`
  - For each: create a Stripe invoice/charge, on success call `DomainPurchaseService.renewDomain()`, update `domain_expires_at`
  - On payment failure: set status to `renewal_due`, retry 3 times over 7 days
- [ ] **Stripe subscription per domain**: After initial purchase, create an annual Stripe subscription so renewals are automatic
  - Webhook `invoice.paid` with domain metadata triggers Porkbun renewal
  - Webhook `invoice.payment_failed` sets status to `renewal_due`
- [ ] **In-app notification**: When a domain is in `renewal_due` status, show a warning in Settings

#### 5. Error Recovery and Edge Cases
- [ ] **Partial provisioning retry**: If orchestrator fails midway (e.g., ACM cert timeout), the user should be able to click "Retry" in Settings to resume from the failed step. The orchestrator is already idempotent — just need a UI trigger.
- [ ] **Orphan cleanup**: If Stripe payment succeeds but provisioning fails completely, we have a `payment_pending` or stuck record. Add a daily check that retries stuck domains or alerts.
- [ ] **DNS propagation delay**: After setting nameservers at Porkbun, it can take up to 48 hours for NS records to propagate. ACM cert validation will fail during this window. The orchestrator should retry `issuing_cert` step with longer polling (currently 5 min max, may need 30+ min).
- [ ] **CloudFront deployment time**: CloudFront distributions take 5-15 minutes to deploy. The SSE/polling UI handles this, but should show a clear "this is normal" message.
- [ ] **Domain already registered elsewhere**: If a user searches for a domain they already own at another registrar, we should eventually support "bring your own domain" (Phase 1 of the existing `docs/custom-domains-plan.md`) — manual DNS pointing, not purchase.

#### 6. Porkbun API Rate Limiting
- [ ] Porkbun limits `checkDomain` to 1 request per 10 seconds. Currently we run checks sequentially which is slow for multi-TLD search (8 TLDs = ~80 seconds worst case).
- [ ] **Fix**: When searching without a TLD, check the most popular 3-4 TLDs first (.com, .org, .net, .io) and return partial results immediately. Load remaining TLDs in the background.
- [ ] Consider caching Porkbun's bulk pricing list (`/pricing/get`) on startup and only using `checkDomain` for availability (not pricing).

#### 7. "Bring Your Own Domain" Support (Phase 1 from existing plan)
- [ ] For users who already own a domain elsewhere and don't want to buy through us
- [ ] UI: "I already have a domain" option in DomainPurchaseModal
- [ ] Show DNS instructions (add A record pointing to our IP or CNAME to CloudFront)
- [ ] Backend verifies DNS, issues cert, creates CloudFront distribution
- [ ] This is Phase 1 from `docs/custom-domains-plan.md` — the infrastructure is mostly built, just needs the verification flow and a simpler UI path

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
