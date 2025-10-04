const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const StripeService = require('./services/StripeService');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const stripeService = new StripeService();

// CORS configuration - allow frontend domain
const allowedOrigins = [
    'https://porkicoder.com',
    'https://www.porkicoder.com',
    ...(process.env.ALLOWED_ORIGINS?.split(',') || [])
];

app.use(cors({
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
}));

// Webhook endpoint (raw body needed)
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    
    try {
        await stripeService.handleWebhook(req.body, sig);
        res.json({ received: true });
    } catch (err) {
        console.error('Webhook error:', err.message);
        res.status(400).send(`Webhook Error: ${err.message}`);
    }
});

// Regular middleware
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

// Customer Portal endpoint
app.post('/api/create-portal-session', async (req, res) => {
    try {
        const { customerId } = req.body;
        
        if (!customerId) {
            return res.status(400).json({ error: 'customerId is required' });
        }

        const session = await stripeService.createPortalSession({
            customerId,
            returnUrl: process.env.FRONTEND_URL
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error('Error creating portal session:', error);
        res.status(500).json({ error: error.message });
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
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Backend server running on port ${PORT}`);
    console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔒 CORS allowed origins:`, allowedOrigins);
    console.log(`🌐 Frontend URL: ${process.env.FRONTEND_URL}`);
});
