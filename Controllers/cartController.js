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

function sanitizeSelection(selection, cart) {
    const selected = Array.isArray(selection)
        ? selection
        : (selection ? [selection] : []);
    const cartNames = new Set((cart || []).map(i => i.name));
    return [...new Set(selected.map(String))].filter(name => cartNames.has(name));
}

module.exports = {

    // GET /cart
    async viewCart(req, res) {
        await hydrateCartFromDb(req);
        const cart = req.session.cart || [];
        const checkoutSelection = sanitizeSelection(req.session.checkoutSelection, cart);
        req.session.checkoutSelection = checkoutSelection;

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
            deliveryType: "normal",
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
            appliedPoints: Number(req.session.cartRedeem?.points || 0),
            checkoutSelection
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
        // Redeem rate: 1 point = $0.01
        const amount = Math.min(subtotal, cappedPoints * 0.01);

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
        req.session.checkoutSelection = sanitizeSelection(req.session.checkoutSelection, req.session.cart);
        if (req.session.user) {
            await CartModel.removeItem(req.session.user.id, name);
        }

        return res.json({ ok: true });
    },

    // POST /cart/preferences
    savePreferences(req, res) {
        const { cutlery, pickupDate, pickupTime, mode, deliveryType, name, address, contact, notes } = req.body;

        if (!req.session.cartPrefs) {
            req.session.cartPrefs = { cutlery: false, pickupDate: "", pickupTime: "", mode: "pickup", deliveryType: "normal", name: "", address: "", contact: "", notes: "" };
        }

        if (typeof cutlery !== "undefined") req.session.cartPrefs.cutlery = !!cutlery;
        if (typeof pickupDate !== "undefined") req.session.cartPrefs.pickupDate = pickupDate || "";
        if (typeof pickupTime !== "undefined") req.session.cartPrefs.pickupTime = pickupTime || "";
        if (mode === "pickup" || mode === "delivery") req.session.cartPrefs.mode = mode;
        if (deliveryType === "normal" || deliveryType === "urgent") req.session.cartPrefs.deliveryType = deliveryType;
        if (typeof name !== "undefined") req.session.cartPrefs.name = name || "";
        if (typeof address !== "undefined") req.session.cartPrefs.address = address || "";
        if (typeof contact !== "undefined") req.session.cartPrefs.contact = contact || "";
        if (typeof notes !== "undefined") req.session.cartPrefs.notes = notes || "";

        return res.json({ ok: true });
    },

    // POST /cart/clear
    async clearCart(req, res) {
        req.session.cart = [];
        req.session.cartPrefs = { cutlery: false, pickupDate: "", pickupTime: "", mode: "pickup", deliveryType: "normal", name: "", address: "", contact: "", notes: "" };
        req.session.cartRedeem = null;
        req.session.checkoutSelection = null;
        if (req.session.user) {
            await CartModel.clearCart(req.session.user.id);
        }
        return res.json({ ok: true });
    },

    // POST /cart/selection
    async saveCheckoutSelection(req, res) {
        await hydrateCartFromDb(req);
        const cart = req.session.cart || [];
        const selection = sanitizeSelection(req.body.names, cart);

        if (!selection.length) {
            return res.status(400).json({ ok: false, error: "Please select at least one item." });
        }

        req.session.checkoutSelection = selection;
        return res.json({ ok: true, count: selection.length });
    }
};
