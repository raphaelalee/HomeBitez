module.exports = {

    viewCart(req, res) {
        const cart = req.session.cart || [];

        // calculate subtotal
        let subtotal = 0;
        cart.forEach(item => subtotal += item.price * item.quantity);

        res.render('carts', { cart, subtotal });
    },

    addToCart(req, res) {
        const { id, name, price } = req.body;

        if (!req.session.cart) {
            req.session.cart = [];
        }

        let existing = req.session.cart.find(item => item.id == id);

        if (existing) {
            existing.quantity += 1;
        } else {
            req.session.cart.push({
                id,
                name,
                price: parseFloat(price),
                quantity: 1
            });
        }

        res.redirect('/cart');
    },

    updateItem(req, res) {
        const { id, quantity } = req.body;

        req.session.cart = req.session.cart.map(item => {
            if (item.id == id) {
                item.quantity = parseInt(quantity);
            }
            return item;
        });

        res.redirect('/cart');
    },

    removeItem(req, res) {
        const { id } = req.body;

        req.session.cart = req.session.cart.filter(item => item.id != id);

        res.redirect('/cart');
    }
};
