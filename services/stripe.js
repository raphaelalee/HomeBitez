// services/stripe.js
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = {
  createCheckoutSession: async ({ items, subtotal, deliveryFee, successUrl, cancelUrl }) => {

    const total = Number(subtotal) + Number(deliveryFee);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'grabpay', 'alipay', 'paynow', 'wechat_pay'],
      payment_method_options: {
        wechat_pay: { client: 'web' }
      },

      line_items: [
        {
          price_data: {
            currency: 'sgd',
            product_data: {
              name: 'HomeBitez Order',
            },
            unit_amount: Math.round(total * 100), // cents
          },
          quantity: 1,
        }
      ],

      mode: 'payment',

      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    return session;
  },

  createWalletTopupSession: async ({ amount, successUrl, cancelUrl, paymentMethodTypes }) => {
    const topupAmount = Number(amount || 0);
    if (!Number.isFinite(topupAmount) || topupAmount <= 0) {
      throw new Error("Invalid top-up amount");
    }

    const pmTypes = paymentMethodTypes || ['card'];
    const paymentMethodOptions = pmTypes.includes('wechat_pay') ? { wechat_pay: { client: 'web' } } : undefined;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: pmTypes,
      payment_method_options: paymentMethodOptions,
      line_items: [
        {
          price_data: {
            currency: 'sgd',
            product_data: { name: 'HomeBitez Wallet Top Up' },
            unit_amount: Math.round(topupAmount * 100)
          },
          quantity: 1
        }
      ],
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        type: 'wallet_topup',
        amount: topupAmount.toFixed(2)
      }
    });

    return session;
  },

  retrieveCheckoutSession: async (sessionId) => {
    if (!sessionId) throw new Error("Missing Stripe session ID");
    return stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent", "customer_details"]
    });
  }
};
