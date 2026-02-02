const CartModel = require("../Models/cartModels");
const UsersModel = require("../Models/UsersModel");

async function hydrateCartFromDb(req) {
    if (!req.session.user) return;
    if (req.session.cart && req.session.cart.length) return;
    const rows = await CartModel.getByUserId(req.session.user.id);
    req.session.cart = rows.map(r => ({
        name: r.name,
        price: Number(r.price || 0),
        quantity: Number(r.quantity || 0),
        image: r.image || ""
    }));
}

module.exports = {

    // GET /cart
    async viewCart(req, res) {
        await hydrateCartFromDb(req);
        const cart = req.session.cart || [];

        let subtotal = 0;
        cart.forEach(item => {
            subtotal += item.price * item.quantity;
        });

        const redeem = Math.min(subtotal, Number(req.session.cartRedeem?.amount || 0));

        // Preferences stored in session
        const prefs = req.session.cartPrefs || {
            cutlery: false,
            pickupDate: "",
            pickupTime: "",
            mode: "pickup",
            name: "",
            address: "",
            contact: "",
            notes: ""
        };

        const availablePoints = req.session.user ? Number(req.session.user.points || 0) : 0;

        res.render('carts', {
            cart,
            subtotal,
            redeem,
            totalAfterRedeem: Number((subtotal - redeem).toFixed(2)),
            prefs,
            availablePoints,
            appliedPoints: Number(req.session.cartRedeem?.points || 0)
        });
    },

    // POST /cart/add  (called by fetch)
    async addToCart(req, res) {
        const { name, price, qty, image } = req.body;

        if (!name || !price) {
            return res.status(400).json({ ok: false, error: "Missing item data" });
        }

        if (!req.session.cart) req.session.cart = [];

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
        if (req.session.user) {
            await CartModel.upsertItem(req.session.user.id, {
                name,
                price: parseFloat(price),
                quantity: Number(qty || 1),
                image: image || ""
            });
        }

        return res.json({ ok: true, cartCount: cart.length });
    },

    // POST /cart/redeem
    async redeemPoints(req, res) {
        if (!req.session.user) {
            return res.redirect('/login');
        }
        await hydrateCartFromDb(req);
        const cart = req.session.cart || [];
        const subtotal = cart.reduce((s, i) => s + Number(i.price || 0) * Number(i.quantity || i.qty || 0), 0);
        const available = Number(req.session.user.points || 0);
        const points = Math.max(0, parseInt(req.body.points, 10) || 0);
        const cappedPoints = Math.min(points, available);
        const amount = Math.min(subtotal, cappedPoints * 0.01); // 1 point = $0.01

        if (!cappedPoints || amount <= 0) {
            req.session.cartRedeem = null;
            return res.redirect('/cart');
        }

        req.session.cartRedeem = { points: cappedPoints, amount };
        return res.redirect('/cart');
    },

    // POST /cart/update
    // Supports:
    //  A) { name, quantity }
    //  B) { name, action: "increase" | "decrease" }
    async updateItem(req, res) {
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

            if (req.session.user) {
                const updated = req.session.cart.find(i => i.name === name);
                if (updated) {
                    await CartModel.updateQuantity(req.session.user.id, name, updated.quantity);
                }
            }

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

        if (req.session.user) {
            await CartModel.updateQuantity(req.session.user.id, name, q);
        }

        return res.json({ ok: true });
    },

    // POST /cart/remove
    async removeItem(req, res) {
        const { name } = req.body;

        if (!req.session.cart) req.session.cart = [];

        req.session.cart = req.session.cart.filter(item => item.name !== name);
        if (req.session.user) {
            await CartModel.removeItem(req.session.user.id, name);
        }

        return res.json({ ok: true });
    },

    // POST /cart/preferences
    savePreferences(req, res) {
        const { cutlery, pickupDate, pickupTime, mode, name, address, contact, notes } = req.body;

        if (!req.session.cartPrefs) {
            req.session.cartPrefs = { cutlery: false, pickupDate: "", pickupTime: "", mode: "pickup", name: "", address: "", contact: "", notes: "" };
        }

        req.session.cartPrefs.cutlery = !!cutlery;
        req.session.cartPrefs.pickupDate = pickupDate || "";
        req.session.cartPrefs.pickupTime = pickupTime || "";
        req.session.cartPrefs.mode = mode || "pickup";
        req.session.cartPrefs.name = name || "";
        req.session.cartPrefs.address = address || "";
        req.session.cartPrefs.contact = contact || "";
        req.session.cartPrefs.notes = notes || "";

        return res.json({ ok: true });
    },

    // POST /cart/clear
    async clearCart(req, res) {
        req.session.cart = [];
        req.session.cartPrefs = { cutlery: false, pickupDate: "", pickupTime: "", mode: "pickup", name: "", address: "", contact: "", notes: "" };
        req.session.cartRedeem = null;
        if (req.session.user) {
            await CartModel.clearCart(req.session.user.id);
        }
        return res.json({ ok: true });
    }
};
