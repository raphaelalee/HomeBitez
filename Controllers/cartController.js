module.exports = {

    // GET /cart
    viewCart(req, res) {
        const cart = req.session.cart || [];

        let subtotal = 0;
        cart.forEach(item => {
            subtotal += item.price * item.quantity;
        });

        res.render('carts', { cart, subtotal });
    },

    // POST /cart/add  (called by fetch)
    addToCart(req, res) {
        const { name, price, qty } = req.body;

        if (!name || !price) {
            return res.status(400).json({ ok: false, error: "Missing item data" });
        }

        if (!req.session.cart) {
            req.session.cart = [];
        }

        const cart = req.session.cart;

        let existing = cart.find(item => item.name === name);

        if (existing) {
            existing.quantity += Number(qty || 1);
        } else {
            cart.push({
                name,
                price: parseFloat(price),
                quantity: Number(qty || 1)
            });
        }

        req.session.cart = cart;

        // IMPORTANT: return JSON, not redirect
        return res.json({ ok: true, cartCount: cart.length });
    },

    // POST /cart/update
    updateItem(req, res) {
        const { name, quantity } = req.body;

        if (!req.session.cart) req.session.cart = [];

        req.session.cart = req.session.cart.map(item => {
            if (item.name === name) {
                item.quantity = parseInt(quantity);
            }
            return item;
        });

        return res.json({ ok: true });
    },

    // POST /cart/remove
    removeItem(req, res) {
        const { name } = req.body;

        if (!req.session.cart) req.session.cart = [];

        req.session.cart = req.session.cart.filter(item => item.name !== name);

        return res.json({ ok: true });
    }
};
