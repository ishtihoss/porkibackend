// Copy your existing StripeService.js exactly as is
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const FREE_USER_REQUEST_LIMIT = 5;

class StripeService {
    constructor() {
        this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
        this.supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_ROLE_KEY
        );
        this.webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    }

    async validateAndIncrementRequest(userId) {
        try {
            await this.ensureUserRecord(userId);

            const { data: userData, error: fetchError } = await this.supabase
                .from('user_request_limits')
                .select('is_premium, request_count, subscription_status')
                .eq('user_id', userId)
                .single();

            if (fetchError) {
                console.error('Error fetching user data:', fetchError);
                throw new Error('Failed to fetch user data');
            }

            const isPremium = userData.is_premium || false;
            const currentCount = userData.request_count || 0;

            if (!isPremium && currentCount >= FREE_USER_REQUEST_LIMIT) {
                return {
                    allowed: false,
                    isPremium,
                    requestCount: currentCount,
                    limit: FREE_USER_REQUEST_LIMIT,
                    message: `You have reached your free request limit of ${FREE_USER_REQUEST_LIMIT} requests. Please upgrade to PorkiCoder Premium for unlimited requests.`
                };
            }

            if (!isPremium) {
                const { error: updateError } = await this.supabase
                    .from('user_request_limits')
                    .update({ 
                        request_count: currentCount + 1,
                        updated_at: new Date().toISOString()
                    })
                    .eq('user_id', userId);

                if (updateError) {
                    console.error('Error incrementing count:', updateError);
                    throw new Error('Failed to increment request count');
                }
            }

            return {
                allowed: true,
                isPremium,
                requestCount: isPremium ? currentCount : currentCount + 1
            };

        } catch (error) {
            console.error('Error in validateAndIncrementRequest:', error);
            throw error;
        }
    }

    async handleWebhook(payload, signature) {
        let event;

        try {
            event = this.stripe.webhooks.constructEvent(
                payload,
                signature,
                this.webhookSecret
            );
        } catch (err) {
            throw new Error(`Webhook signature verification failed: ${err.message}`);
        }

        console.log(`Processing webhook event: ${event.type}`);

        switch (event.type) {
            case 'checkout.session.completed':
                await this.handleCheckoutCompleted(event.data.object);
                break;

            case 'customer.subscription.created':
            case 'customer.subscription.updated':
                await this.handleSubscriptionUpdate(event.data.object);
                break;

            case 'customer.subscription.deleted':
                await this.handleSubscriptionDeleted(event.data.object);
                break;

            case 'invoice.payment_succeeded':
                await this.handleInvoicePaymentSucceeded(event.data.object);
                break;

            case 'invoice.payment_failed':
                await this.handleInvoicePaymentFailed(event.data.object);
                break;

            default:
                console.log(`Unhandled event type: ${event.type}`);
        }
    }

    async handleCheckoutCompleted(session) {
        const userId = session.metadata?.userId;
        const customerId = session.customer;

        if (!userId) {
            console.error('No userId in checkout session metadata');
            return;
        }

        await this.ensureUserRecord(userId);

        const { error } = await this.supabase
            .from('user_request_limits')
            .update({
                stripe_customer_id: customerId,
                updated_at: new Date().toISOString()
            })
            .eq('user_id', userId);

        if (error) {
            console.error('Error updating customer ID:', error);
            throw error;
        }

        console.log(`Updated user ${userId} with customer ID ${customerId}`);
    }

    async handleSubscriptionUpdate(subscription) {
        const customerId = subscription.customer;
        const subscriptionId = subscription.id;
        const status = subscription.status;
        const currentPeriodEnd = new Date(subscription.current_period_end * 1000);

        try {
            await this.supabase.rpc('update_premium_status_from_webhook', {
                p_stripe_customer_id: customerId,
                p_subscription_id: subscriptionId,
                p_status: status,
                p_end_date: currentPeriodEnd.toISOString()
            });

            console.log(`Updated subscription ${subscriptionId} status to ${status}`);
        } catch (error) {
            console.error('Error updating subscription:', error);
            throw error;
        }
    }

    async handleSubscriptionDeleted(subscription) {
        const customerId = subscription.customer;
        const subscriptionId = subscription.id;

        try {
            await this.supabase.rpc('update_premium_status_from_webhook', {
                p_stripe_customer_id: customerId,
                p_subscription_id: subscriptionId,
                p_status: 'canceled',
                p_end_date: new Date().toISOString()
            });

            console.log(`Marked subscription ${subscriptionId} as canceled`);
        } catch (error) {
            console.error('Error handling subscription deletion:', error);
            throw error;
        }
    }

    async handleInvoicePaymentSucceeded(invoice) {
        console.log(`Invoice ${invoice.id} payment succeeded for customer ${invoice.customer}`);
    }

    async handleInvoicePaymentFailed(invoice) {
        console.log(`Invoice ${invoice.id} payment failed for customer ${invoice.customer}`);
    }

    async createCheckoutSession({ userId, email, priceId, successUrl, cancelUrl }) {
        await this.ensureUserRecord(userId);

        const { data: userData } = await this.supabase
            .from('user_request_limits')
            .select('stripe_customer_id')
            .eq('user_id', userId)
            .single();

        let customerId = userData?.stripe_customer_id;

        if (!customerId) {
            const customer = await this.stripe.customers.create({
                email,
                metadata: { userId }
            });
            customerId = customer.id;

            await this.supabase
                .from('user_request_limits')
                .update({ stripe_customer_id: customerId })
                .eq('user_id', userId);
        }

        const session = await this.stripe.checkout.sessions.create({
            customer: customerId,
            payment_method_types: ['card'],
            line_items: [{
                price: priceId,
                quantity: 1,
            }],
            mode: 'subscription',
            success_url: successUrl,
            cancel_url: cancelUrl,
            metadata: { userId }
        });

        return session;
    }

    async createPortalSession({ customerId, returnUrl }) {
        const session = await this.stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: returnUrl,
        });

        return session;
    }

    async getSubscriptionStatus(userId) {
        const { data, error } = await this.supabase
            .from('user_request_limits')
            .select('*')
            .eq('user_id', userId)
            .single();

        if (error && error.code !== 'PGRST116') {
            throw error;
        }

        if (!data) {
            await this.ensureUserRecord(userId);
            return {
                isPremium: false,
                requestCount: 0,
                subscriptionStatus: null,
                subscriptionEndDate: null
            };
        }

        return {
            isPremium: data.is_premium,
            requestCount: data.request_count,
            subscriptionStatus: data.subscription_status,
            subscriptionEndDate: data.subscription_end_date,
            stripeCustomerId: data.stripe_customer_id
        };
    }

    async ensureUserRecord(userId) {
        const { data: existing } = await this.supabase
            .from('user_request_limits')
            .select('id')
            .eq('user_id', userId)
            .single();

        if (!existing) {
            const { error } = await this.supabase
                .from('user_request_limits')
                .insert({
                    user_id: userId,
                    request_count: 0,
                    is_premium: false
                });

            if (error) {
                console.error('Error creating user record:', error);
                throw error;
            }
        }
    }
}

module.exports = StripeService;
