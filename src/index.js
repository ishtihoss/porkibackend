const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const StripeService = require('./services/StripeService');
const PublishService = require('./services/PublishService');
const DomainSearchService = require('./services/DomainSearchService');
const DomainOrchestrator = require('./services/DomainOrchestrator');

dotenv.config();

// Validate required environment variables
const requiredEnvVars = [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_PRICE_ID',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'FRONTEND_URL'
];

const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
    console.error('❌ Missing required environment variables:');
    missingEnvVars.forEach(varName => console.error(`   - ${varName}`));
    console.error('\n💡 Please check your .env file');
    process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

const stripeService = new StripeService();
const publishService = new PublishService();

// Shared Supabase client for domain endpoints
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Domain services (only initialize if Porkbun keys are configured)
let domainSearchService = null;
let domainOrchestrator = null;
if (process.env.PORKBUN_API_KEY && process.env.PORKBUN_SECRET_KEY) {
    domainSearchService = new DomainSearchService();
    domainOrchestrator = new DomainOrchestrator();
    console.log('🌐 Domain purchase services initialized');
} else {
    console.log('⚠️ Domain purchase disabled (PORKBUN_API_KEY not set)');
}

// CORS configuration - allow frontend domain
const allowedOrigins = [
    'https://porkicoder.com',
    'https://www.porkicoder.com',
    ...(process.env.ALLOWED_ORIGINS?.split(',') || [])
];

const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (Electron, mobile apps, curl)
        if (!origin) {
            return callback(null, true);
        }
        
        // Allow all origins if wildcard is set
        if (allowedOrigins.includes('*')) {
            return callback(null, true);
        }
        
        // Check against allowed origins list
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        
        // Block everything else
        console.warn('❌ CORS blocked origin:', origin);
        callback(new Error('Not allowed by CORS'));
    },
    credentials: true
};

// ⚠️ CRITICAL: Webhook endpoint MUST be defined BEFORE any body parsers or CORS
// Stripe webhooks need raw body for signature verification and don't send CORS headers
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    
    console.log('🔔 Stripe webhook received');
    console.log('  IP:', req.ip || req.connection.remoteAddress);
    console.log('  Has signature:', !!sig);
    console.log('  Body size:', req.body?.length || 0);
    
    if (!sig) {
        console.error('❌ Missing stripe-signature header');
        return res.status(400).send('Missing stripe-signature header');
    }
    
    try {
        await stripeService.handleWebhook(req.body, sig);
        console.log('✅ Webhook processed successfully');
        res.json({ received: true });
    } catch (err) {
        console.error('❌ Webhook error:', err.message);
        res.status(400).send(`Webhook Error: ${err.message}`);
    }
});

// ⚠️ CRITICAL: Deploy endpoint MUST be defined BEFORE global body parsers
// because it needs a 100MB body limit (global default is 100KB)
app.post('/api/publish/deploy', cors(corsOptions), express.json({ limit: '100mb' }), async (req, res) => {
    try {
        const { userId, subdomain, files } = req.body;
        if (!userId || !subdomain || !files) {
            return res.status(400).json({ error: 'userId, subdomain, and files are required' });
        }

        console.log(`📦 Publish deploy: user=${userId} subdomain=${subdomain} files=${files.length}`);
        const result = await publishService.deploy(userId, subdomain, files);

        if (result.error) {
            const status = result.error === 'PREMIUM_REQUIRED' ? 403 : 400;
            return res.status(status).json(result);
        }

        res.json(result);
    } catch (error) {
        console.error('Error deploying site:', error);
        res.status(500).json({ error: error.message });
    }
});

// Apply CORS to all other routes
app.use(cors(corsOptions));

// Regular middleware (after webhook route and deploy route)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API Routes
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        service: 'porkicoder-backend',
        version: '2.0.0'
    });
});

// Validate and increment request count
app.post('/api/validate-request', async (req, res) => {
    try {
        const { userId } = req.body;
        
        console.log('📥 Validate request received');
        console.log('  User ID:', userId);
        console.log('  Origin:', req.headers.origin || 'NONE');
        console.log('  User-Agent:', req.headers['user-agent']);
        
        if (!userId) {
            return res.status(400).json({ error: 'userId is required' });
        }

        const result = await stripeService.validateAndIncrementRequest(userId);
        
        if (!result.allowed) {
            console.log('❌ Request denied - rate limit');
            return res.status(403).json({ 
                allowed: false,
                isPremium: result.isPremium,
                requestCount: result.requestCount,
                limit: result.limit,
                message: result.message
            });
        }

        console.log('✅ Request allowed');
        res.json({
            allowed: true,
            isPremium: result.isPremium,
            requestCount: result.requestCount
        });

    } catch (error) {
        console.error('❌ Error validating request:', error);
        res.status(500).json({ error: error.message });
    }
});

// Stripe Checkout Session endpoint
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const { userId, email, priceId } = req.body;
        
        if (!userId || !email) {
            return res.status(400).json({ error: 'userId and email are required' });
        }

        const session = await stripeService.createCheckoutSession({
            userId,
            email,
            priceId: priceId || process.env.STRIPE_PRICE_ID,
            successUrl: `${process.env.FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
            cancelUrl: `${process.env.FRONTEND_URL}/cancel.html`
        });

        res.json({ sessionId: session.id, url: session.url });
    } catch (error) {
        console.error('Error creating checkout session:', error);
        res.status(500).json({ error: error.message });
    }
});

// Customer Portal endpoint - UPDATED to accept userId OR customerId
app.post('/api/create-portal-session', async (req, res) => {
    try {
        const { customerId, userId } = req.body;
        
        console.log('🔐 Portal session request:', { userId, customerId: customerId ? 'provided' : 'not provided' });
        
        // Need either customerId or userId
        if (!customerId && !userId) {
            return res.status(400).json({ error: 'customerId or userId is required' });
        }

        // If userId provided but no customerId, look it up
        let finalCustomerId = customerId;
        if (!finalCustomerId && userId) {
            console.log('Looking up customer ID for userId:', userId);
            const status = await stripeService.getSubscriptionStatus(userId);
            finalCustomerId = status.stripeCustomerId;
            
            if (!finalCustomerId) {
                return res.status(404).json({ 
                    error: 'No subscription found. Please upgrade to Premium first.' 
                });
            }
            console.log('Found customer ID:', finalCustomerId);
        }

        const session = await stripeService.createPortalSession({
            customerId: finalCustomerId,
            returnUrl: process.env.FRONTEND_URL
        });

        console.log('✅ Portal session created:', session.id);
        res.json({ url: session.url });
    } catch (error) {
        console.error('❌ Error creating portal session:', error);
        res.status(500).json({ 
            error: 'Failed to create billing portal session',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Get subscription status
app.get('/api/subscription-status/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        console.log('📊 Getting subscription status for:', userId);
        
        const status = await stripeService.getSubscriptionStatus(userId);
        res.json(status);
    } catch (error) {
        console.error('Error getting subscription status:', error);
        res.status(500).json({ error: error.message });
    }
});

// ── Publish endpoints ────────────────────────────────────────────────

app.post('/api/publish/check-subdomain', async (req, res) => {
    try {
        const { userId, subdomain } = req.body;
        if (!userId || !subdomain) {
            return res.status(400).json({ error: 'userId and subdomain are required' });
        }
        const result = await publishService.checkSubdomain(userId, subdomain);
        res.json(result);
    } catch (error) {
        console.error('Error checking subdomain:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/publish/sites/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const sites = await publishService.listSites(userId);
        res.json({ sites });
    } catch (error) {
        console.error('Error listing sites:', error);
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/publish/sites/:userId/:subdomain', async (req, res) => {
    try {
        const { userId, subdomain } = req.params;
        const result = await publishService.deleteSite(userId, subdomain);

        if (result.error) {
            const status = result.error === 'FORBIDDEN' ? 403 : 404;
            return res.status(status).json(result);
        }

        res.json(result);
    } catch (error) {
        console.error('Error deleting site:', error);
        res.status(500).json({ error: error.message });
    }
});

// ── Domain purchase endpoints ────────────────────────────────────────

/**
 * Middleware: reject domain requests if services not configured.
 */
function requireDomainServices(req, res, next) {
    if (!domainSearchService || !domainOrchestrator) {
        return res.status(503).json({ error: 'Domain purchase service not configured' });
    }
    next();
}

// Search domain availability + pricing
app.post('/api/domains/search', requireDomainServices, async (req, res) => {
    try {
        const { query } = req.body;
        if (!query || typeof query !== 'string') {
            return res.status(400).json({ error: 'query is required' });
        }

        console.log(`🔍 Domain search: ${query}`);
        const results = await domainSearchService.search(query);

        // Add markup pricing
        for (const result of results.results) {
            if (result.price) {
                result.userPriceCents = domainSearchService.getMarkupPrice(result.price);
                result.renewalPriceCents = domainSearchService.getMarkupPrice(result.renewalPrice || result.price);
            }
        }

        res.json(results);
    } catch (error) {
        console.error('Error searching domains:', error);
        res.status(500).json({ error: error.message });
    }
});

// Initiate domain purchase: creates Stripe checkout session
app.post('/api/domains/purchase', requireDomainServices, async (req, res) => {
    try {
        const { userId, email, domain, subdomain, priceCents } = req.body;
        if (!userId || !email || !domain || !subdomain || !priceCents) {
            return res.status(400).json({
                error: 'userId, email, domain, subdomain, and priceCents are required'
            });
        }

        console.log(`💳 Domain purchase initiated: ${domain} for user ${userId}`);

        // Check domain isn't already registered in our system

        const { data: existing } = await supabase
            .from('custom_domains')
            .select('id, user_id, status')
            .eq('domain', domain)
            .maybeSingle();

        if (existing) {
            if (existing.user_id === userId && existing.status === 'active') {
                return res.status(400).json({ error: 'You already own this domain' });
            }
            if (existing.user_id !== userId) {
                return res.status(400).json({ error: 'This domain is already registered by another user' });
            }
        }

        // Verify the subdomain belongs to this user
        const { data: site } = await supabase
            .from('published_sites')
            .select('user_id')
            .eq('subdomain', subdomain)
            .maybeSingle();

        if (!site || site.user_id !== userId) {
            return res.status(400).json({ error: 'You do not own this published site' });
        }

        // Create Stripe checkout session for domain purchase
        const session = await stripeService.createDomainCheckoutSession({
            userId,
            email,
            domain,
            subdomain,
            priceCents,
        });

        // Create pending domain record
        if (!existing) {
            await supabase.from('custom_domains').insert({
                user_id: userId,
                subdomain,
                domain,
                status: 'payment_pending',
                stripe_checkout_session_id: session.id,
                purchase_price_cents: priceCents,
                renewal_price_cents: priceCents,
            });
        } else {
            await supabase.from('custom_domains')
                .update({
                    status: 'payment_pending',
                    stripe_checkout_session_id: session.id,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', existing.id);
        }

        res.json({ sessionId: session.id, url: session.url });
    } catch (error) {
        console.error('Error initiating domain purchase:', error);
        res.status(500).json({ error: error.message });
    }
});

// SSE endpoint: real-time provisioning progress
app.get('/api/domains/status/:domainId', requireDomainServices, async (req, res) => {
    const { domainId } = req.params;

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });

    // Send current status immediately
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: domain } = await supabase
        .from('custom_domains')
        .select('status, domain')
        .eq('id', domainId)
        .single();

    if (domain) {
        res.write(`data: ${JSON.stringify({ step: domain.status, domain: domain.domain })}\n\n`);
    }

    // Register for future updates
    domainOrchestrator.addSseClient(domainId, res);

    // Keep-alive ping every 30s
    const keepAlive = setInterval(() => {
        try { res.write(': keepalive\n\n'); } catch (e) { clearInterval(keepAlive); }
    }, 30000);

    req.on('close', () => clearInterval(keepAlive));
});

// List user's custom domains
app.get('/api/domains/list/:userId', async (req, res) => {
    try {
        const { userId } = req.params;


        const { data, error } = await supabase
            .from('custom_domains')
            .select('id, domain, subdomain, status, purchase_price_cents, renewal_price_cents, domain_registered_at, domain_expires_at, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json({ domains: data || [] });
    } catch (error) {
        console.error('Error listing domains:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete domain + tear down infrastructure
app.delete('/api/domains/:userId/:domain', requireDomainServices, async (req, res) => {
    try {
        const { userId, domain: domainName } = req.params;


        const { data: domain } = await supabase
            .from('custom_domains')
            .select('*')
            .eq('domain', domainName)
            .eq('user_id', userId)
            .single();

        if (!domain) {
            return res.status(404).json({ error: 'Domain not found' });
        }

        // Tear down AWS infrastructure
        await domainOrchestrator.teardown(domain.id);

        // Delete the record
        await supabase
            .from('custom_domains')
            .delete()
            .eq('id', domain.id);

        console.log(`🗑️ Domain deleted: ${domainName}`);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting domain:', error);
        res.status(500).json({ error: error.message });
    }
});

// Initiate domain transfer out
app.post('/api/domains/transfer/:domain', requireDomainServices, async (req, res) => {
    try {
        const { domain: domainName } = req.params;
        const { userId } = req.body;


        const { data: domain } = await supabase
            .from('custom_domains')
            .select('*')
            .eq('domain', domainName)
            .eq('user_id', userId)
            .single();

        if (!domain) {
            return res.status(404).json({ error: 'Domain not found' });
        }

        if (domain.status !== 'active') {
            return res.status(400).json({ error: 'Domain must be active to transfer' });
        }

        const DomainPurchaseService = require('./services/DomainPurchaseService');
        const purchaseService = new DomainPurchaseService();
        const result = await purchaseService.initiateTransfer(domainName);

        await supabase
            .from('custom_domains')
            .update({ status: 'transfer_out', updated_at: new Date().toISOString() })
            .eq('id', domain.id);

        res.json({ success: true, authCode: result.authCode });
    } catch (error) {
        console.error('Error initiating transfer:', error);
        res.status(500).json({ error: error.message });
    }
});

// Change which published site a domain points to
app.post('/api/domains/change-site/:domain', requireDomainServices, async (req, res) => {
    try {
        const { domain: domainName } = req.params;
        const { userId, newSubdomain } = req.body;

        if (!userId || !newSubdomain) {
            return res.status(400).json({ error: 'userId and newSubdomain are required' });
        }


        // Verify domain ownership
        const { data: domain } = await supabase
            .from('custom_domains')
            .select('*')
            .eq('domain', domainName)
            .eq('user_id', userId)
            .single();

        if (!domain) {
            return res.status(404).json({ error: 'Domain not found' });
        }

        // Verify new subdomain ownership
        const { data: site } = await supabase
            .from('published_sites')
            .select('user_id')
            .eq('subdomain', newSubdomain)
            .maybeSingle();

        if (!site || site.user_id !== userId) {
            return res.status(400).json({ error: 'You do not own this published site' });
        }

        await domainOrchestrator.changeSite(domain.id, newSubdomain);

        res.json({ success: true, domain: domainName, subdomain: newSubdomain });
    } catch (error) {
        console.error('Error changing site:', error);
        res.status(500).json({ error: error.message });
    }
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Error handling
app.use((err, req, res, next) => {
    console.error('Global error handler:', err);
    res.status(500).json({ 
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Backend server running on port ${PORT}`);
    console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔒 CORS allowed origins:`, allowedOrigins);
    console.log(`🌐 Frontend URL: ${process.env.FRONTEND_URL}`);
    console.log(`🔔 Stripe webhook endpoint: /webhook/stripe`);
    console.log(`🔐 Webhook secret configured: ${!!process.env.STRIPE_WEBHOOK_SECRET}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('👋 SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('✅ HTTP server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('\n👋 SIGINT signal received: closing HTTP server');
    server.close(() => {
        console.log('✅ HTTP server closed');
        process.exit(0);
    });
});
