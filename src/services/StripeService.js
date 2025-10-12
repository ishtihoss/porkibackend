
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

        console.log(`Processing webhook event: ${event.type} (ID: ${event.id}, Created: ${new Date(event.created * 1000).toISOString()})`);

        switch (event.type) {
            case 'checkout.session.completed':
                await this.handleCheckoutCompleted(event.data.object, event.created);
                break;

            case 'customer.subscription.created':
            case 'customer.subscription.updated':
                await this.handleSubscriptionUpdate(event.data.object, event.created);
                break;

            case 'customer.subscription.deleted':
                await this.handleSubscriptionDeleted(event.data.object, event.created);
                break;

            case 'invoice.paid':
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

    async handleCheckoutCompleted(session, eventTimestamp) {
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

        console.log(`✅ Checkout completed - User ${userId} with customer ID ${customerId}`);
    }

    async handleSubscriptionUpdate(subscription, eventTimestamp) {
        const customerId = subscription.customer;
        const subscriptionId = subscription.id;
        let status = subscription.status;
        
        // Check for scheduled cancellation
        if (subscription.cancel_at_period_end === true && status === 'active') {
            status = 'canceling';
        }
        
        // Get the current period end
        let currentPeriodEnd;
        if (subscription.current_period_end) {
            currentPeriodEnd = new Date(subscription.current_period_end * 1000);
        } else if (subscription.items && subscription.items.data && subscription.items.data.length > 0) {
            currentPeriodEnd = new Date(subscription.items.data[0].current_period_end * 1000);
        } else {
            const billingAnchor = subscription.billing_cycle_anchor;
            const interval = subscription.plan?.interval || 'month';
            const intervalCount = subscription.plan?.interval_count || 1;
            
            currentPeriodEnd = new Date(billingAnchor * 1000);
            if (interval === 'month') {
                currentPeriodEnd.setMonth(currentPeriodEnd.getMonth() + intervalCount);
            } else if (interval === 'year') {
                currentPeriodEnd.setFullYear(currentPeriodEnd.getFullYear() + intervalCount);
            } else if (interval === 'week') {
                currentPeriodEnd.setDate(currentPeriodEnd.getDate() + (7 * intervalCount));
            } else if (interval === 'day') {
                currentPeriodEnd.setDate(currentPeriodEnd.getDate() + intervalCount);
            }
        }

        console.log(`📊 Subscription update details:
            Event Timestamp: ${new Date(eventTimestamp * 1000).toISOString()}
            Customer: ${customerId}
            Subscription: ${subscriptionId}
            Status: ${status}
            Cancel at period end: ${subscription.cancel_at_period_end}
            Current Period End: ${currentPeriodEnd.toISOString()}`);

        try {
            // Let the RPC handle ALL business logic (timestamp checks, status validation, etc.)
            const { data, error } = await this.supabase.rpc('update_premium_status_from_webhook', {
                p_stripe_customer_id: customerId,
                p_subscription_id: subscriptionId,
                p_status: status,
                p_end_date: currentPeriodEnd.toISOString(),
                p_webhook_timestamp: new Date(eventTimestamp * 1000).toISOString()
            });

            if (error) {
                console.error('❌ Error calling RPC:', error);
                throw error;
            }

            // Log the result from RPC
            if (data?.updated === false) {
                console.log(`⏭️  Subscription update skipped: ${data.reason}`);
                if (data.existing_timestamp) {
                    console.log(`   Existing timestamp: ${data.existing_timestamp}`);
                    console.log(`   New timestamp: ${data.new_timestamp}`);
                }
                if (data.existing_status) {
                    console.log(`   Existing status: ${data.existing_status}`);
                    console.log(`   Attempted status: ${data.attempted_status}`);
                }
            } else {
                console.log(`✅ Subscription ${subscriptionId} updated successfully`);
                console.log(`   Status: ${data.status}`);
                console.log(`   Is Premium: ${data.is_premium}`);
            }

        } catch (error) {
            console.error('Error updating subscription:', error);
            throw error;
        }
    }

    async handleSubscriptionDeleted(subscription, eventTimestamp) {
        const customerId = subscription.customer;
        const subscriptionId = subscription.id;

        try {
            const { data, error } = await this.supabase.rpc('update_premium_status_from_webhook', {
                p_stripe_customer_id: customerId,
                p_subscription_id: subscriptionId,
                p_status: 'canceled',
                p_end_date: new Date().toISOString(),
                p_webhook_timestamp: new Date(eventTimestamp * 1000).toISOString()
            });

            if (error) {
                console.error('❌ Error calling RPC:', error);
                throw error;
            }

            if (data?.updated === false) {
                console.log(`⏭️  Subscription deletion skipped: ${data.reason}`);
            } else {
                console.log(`🚫 Subscription ${subscriptionId} canceled for customer ${customerId}`);
            }
        } catch (error) {
            console.error('Error handling subscription deletion:', error);
            throw error;
        }
    }

    async handleInvoicePaymentSucceeded(invoice) {
        const customerId = invoice.customer;
        const subscriptionId = invoice.subscription;
        const amountPaid = invoice.amount_paid / 100;
        const billingReason = invoice.billing_reason;

        console.log(`💰 Invoice payment succeeded:
            Customer: ${customerId}
            Subscription: ${subscriptionId}
            Amount: $${amountPaid}
            Billing Reason: ${billingReason}
            Invoice ID: ${invoice.id}`);
    }

    async handleInvoicePaymentFailed(invoice) {
        const customerId = invoice.customer;
        const subscriptionId = invoice.subscription;
        const amountDue = invoice.amount_due / 100;
        const attemptCount = invoice.attempt_count;

        console.error(`❌ Invoice payment failed:
            Customer: ${customerId}
            Subscription: ${subscriptionId}
            Amount Due: $${amountDue}
            Attempt: ${attemptCount}
            Invoice ID: ${invoice.id}`);
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
