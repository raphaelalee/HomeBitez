module.exports = {

    // GET /cart
    viewCart(req, res) {
        const cart = req.session.cart || [];

        let subtotal = 0;
        cart.forEach(item => {
            subtotal += item.price * item.quantity;
        });

        // Preferences stored in session
        const prefs = req.session.cartPrefs || {
            cutlery: false,
            pickupDate: "",
            pickupTime: ""
        };

        res.render('carts', { cart, subtotal, prefs });
    },

    // POST /cart/add  (called by fetch)
    addToCart(req, res) {
        const { name, price, qty, image } = req.body;

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
                quantity: Number(qty || 1),
                image: image || ""   // optional
            });
        }

        req.session.cart = cart;

        return res.json({ ok: true, cartCount: cart.length });
    },

    // POST /cart/update
    // Supports:
    //  A) { name, quantity }
    //  B) { name, action: "increase" | "decrease" }
    updateItem(req, res) {
        const { name, quantity, action } = req.body;

        if (!req.session.cart) req.session.cart = [];

        // If action mode
        if (name && action) {
            req.session.cart = req.session.cart.map(item => {
                if (item.name === name) {
                    if (action === "increase") item.quantity += 1;
                    if (action === "decrease") item.quantity -= 1;
                    if (item.quantity < 1) item.quantity = 1;
                }
                return item;
            });

            return res.json({ ok: true });
        }

        // If quantity mode
        if (!name || quantity === undefined || quantity === null) {
            return res.status(400).json({ ok: false, error: "Missing name/quantity" });
        }

        let q = parseInt(quantity);
        if (isNaN(q) || q < 1) q = 1;

        req.session.cart = req.session.cart.map(item => {
            if (item.name === name) {
                item.quantity = q;
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
    },

    // POST /cart/preferences
    savePreferences(req, res) {
        const { cutlery, pickupDate, pickupTime, mode, address, contact, notes } = req.body;

        if (!req.session.cartPrefs) {
            req.session.cartPrefs = { cutlery: false, pickupDate: "", pickupTime: "", mode: "pickup", address: "", contact: "", notes: "" };
        }

        req.session.cartPrefs.cutlery = !!cutlery;
        req.session.cartPrefs.pickupDate = pickupDate || "";
        req.session.cartPrefs.pickupTime = pickupTime || "";
        req.session.cartPrefs.mode = mode || "pickup";
        req.session.cartPrefs.address = address || "";
        req.session.cartPrefs.contact = contact || "";
        req.session.cartPrefs.notes = notes || "";

        return res.json({ ok: true });
    },

    // POST /cart/clear
    clearCart(req, res) {
        req.session.cart = [];
        req.session.cartPrefs = { cutlery: false, pickupDate: "", pickupTime: "", mode: "pickup", address: "", contact: "", notes: "" };
        return res.json({ ok: true });
    }
};
