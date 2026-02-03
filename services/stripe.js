// services/stripe.js
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = {
  createCheckoutSession: async ({ items, subtotal, deliveryFee, successUrl, cancelUrl }) => {

    const total = Number(subtotal) + Number(deliveryFee);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],

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

  retrieveCheckoutSession: async (sessionId) => {
    if (!sessionId) throw new Error("Missing Stripe session ID");
    return stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent", "customer_details"]
    });
  }
};
