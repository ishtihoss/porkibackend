const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const StripeService = require('./services/StripeService');
const PublishService = require('./services/PublishService');

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
