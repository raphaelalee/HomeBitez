const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
require("dotenv").config();
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const FacebookStrategy = require('passport-facebook').Strategy;
const stripeService = require('./services/stripe');
const nets = require("./services/nets");
const paypal = require('@paypal/checkout-server-sdk');
const { sendEmail } = require("./services/email");

const NETS_TXN_ID =
    process.env.NETS_TXN_ID ||
    "sandbox_nets|m|8ff8e5b6-d43e-4786-8ac5-7accf8c5bd9b";

const environment = new paypal.core.SandboxEnvironment(
  process.env.PAYPAL_CLIENT_ID,
  process.env.PAYPAL_CLIENT_SECRET
);

const paypalClient = new paypal.core.PayPalHttpClient(environment);


// Controllers
const UsersController = require('./Controllers/usersController');
const ReportModel = require('./models/ReportModel');
const ProductModel = require('./Models/ProductModel');
const OrdersModel = require('./Models/OrdersModel');
const UsersModel = require('./Models/UsersModel');
const CartModel = require('./Models/cartModels');

// DB
const db = require('./db');


let reportColumnsEnsured = false;
async function ensureReportReplyColumns() {
    if (reportColumnsEnsured) return;
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS report_messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NULL,
                name VARCHAR(100) NOT NULL,
                email VARCHAR(150) NOT NULL,
                subject VARCHAR(200) NOT NULL,
                description TEXT NOT NULL,
                order_id VARCHAR(50) NULL,
                address VARCHAR(255) NULL,
                image_url VARCHAR(255) NULL,
                status ENUM('new','in_progress','resolved') DEFAULT 'new',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                admin_reply TEXT NULL,
                replied_at DATETIME NULL,
                replied_by INT NULL,
                user_reply TEXT NULL,
                user_reply_at DATETIME NULL
            )
        `);
    } catch (err) {}
    try {
        await db.query("ALTER TABLE report_messages ADD COLUMN admin_reply TEXT NULL");
    } catch (err) {}
    try {
        await db.query("ALTER TABLE report_messages ADD COLUMN replied_at DATETIME NULL");
    } catch (err) {}
    try {
        await db.query("ALTER TABLE report_messages ADD COLUMN replied_by INT NULL");
    } catch (err) {}
    try {
        await db.query("ALTER TABLE report_messages ADD COLUMN user_reply TEXT NULL");
    } catch (err) {}
    try {
        await db.query("ALTER TABLE report_messages ADD COLUMN user_reply_at DATETIME NULL");
    } catch (err) {}
    try {
        await db.query("ALTER TABLE report_messages ADD COLUMN order_id VARCHAR(50) NULL");
    } catch (err) {}
    try {
        await db.query("ALTER TABLE report_messages ADD COLUMN address VARCHAR(255) NULL");
    } catch (err) {}
    try {
        await db.query("ALTER TABLE report_messages ADD COLUMN image_url VARCHAR(255) NULL");
    } catch (err) {}
    try {
        await db.query("ALTER TABLE report_messages ADD COLUMN status ENUM('new','in_progress','resolved') DEFAULT 'new'");
    } catch (err) {}
    reportColumnsEnsured = true;
}

let refundTableEnsured = false;
async function ensureRefundTable() {
    if (refundTableEnsured) return;
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS refund_requests (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                order_id INT NOT NULL,
                name VARCHAR(100) NOT NULL,
                email VARCHAR(150) NOT NULL,
                amount DECIMAL(10,2) NOT NULL,
                reason VARCHAR(100) NOT NULL,
                refund_method ENUM('original','wallet') DEFAULT 'original',
                details TEXT NOT NULL,
                status ENUM('pending','approved','rejected') DEFAULT 'pending',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_refund_user (user_id),
                INDEX idx_refund_order (order_id)
            )
        `);
    } catch (err) {
        console.error("ensureRefundTable failed:", err);
    }
    try {
        await db.query("ALTER TABLE refund_requests ADD COLUMN refund_method ENUM('original','wallet') DEFAULT 'original'");
    } catch (err) {}
    refundTableEnsured = true;
}

let messagesTableEnsured = false;
async function ensureMessagesTable() {
    if (messagesTableEnsured) return;
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                senderId INT NOT NULL,
                ownerId INT NULL,
                message TEXT NOT NULL,
                isRead TINYINT(1) DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT fk_messages_sender FOREIGN KEY (senderId) REFERENCES users(id)
            )
        `);
    } catch (err) {
        console.error("ensureMessagesTable create failed:", err);
    }
    try {
        await db.query("ALTER TABLE messages MODIFY ownerId INT NULL");
    } catch (err) {
        // ignore if column already nullable or missing
    }
    messagesTableEnsured = true;
}

let walletColumnEnsured = false;
async function ensureWalletColumn() {
    if (walletColumnEnsured) return;
    try {
        await db.query("ALTER TABLE users ADD COLUMN wallet_balance DECIMAL(10,2) NOT NULL DEFAULT 0");
    } catch (err) {
        // ignore if column exists or alter fails
    }
    walletColumnEnsured = true;
}

let walletTxnTableEnsured = false;
async function ensureWalletTransactionsTable() {
    if (walletTxnTableEnsured) return;
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS wallet_transactions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                type ENUM('topup','payment') NOT NULL,
                method VARCHAR(50) NULL,
                amount DECIMAL(10,2) NOT NULL,
                balance_after DECIMAL(10,2) NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_wallet_user (user_id),
                CONSTRAINT fk_wallet_user FOREIGN KEY (user_id) REFERENCES users(id)
            )
        `);
    } catch (err) {
        console.error("ensureWalletTransactionsTable failed:", err);
    }
    walletTxnTableEnsured = true;
}

async function recordWalletTxn(userId, type, method, amount, balanceAfter) {
    try {
        await ensureWalletTransactionsTable();
        await db.query(
            "INSERT INTO wallet_transactions (user_id, type, method, amount, balance_after) VALUES (?,?,?,?,?)",
            [userId, type, method || null, amount, balanceAfter]
        );
    } catch (err) {
        console.error("recordWalletTxn failed:", err);
    }
}

// Initialize app
const app = express();

/* -------------------- MIDDLEWARE -------------------- */

// Parse request bodies
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Sessions (IMPORTANT for cart)
app.use(session({
    secret: 'supersecretkey123',
    resave: false,
    saveUninitialized: true   // important for cart + fetch
}));

// Passport (OAuth)
app.use(passport.initialize());

// Make user available in views
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.currentUser = req.session.user || null;
    next();
});

app.use(flash());

function generateTwoFactorCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

function maskEmail(email) {
    if (!email || typeof email !== 'string' || !email.includes('@')) return '-';
    const parts = email.split('@');
    const name = parts[0];
    const domain = parts.slice(1).join('@');
    if (name.length <= 2) return name[0] + "***@" + domain;
    return name[0] + "***" + name[name.length - 1] + "@" + domain;
}

function maskPhone(phone) {
    if (!phone || typeof phone !== 'string') return '-';
    const digits = phone.replace(/\D/g, '');
    if (!digits) return '-';
    const tail = digits.slice(-4);
    return "***" + tail;
}

async function issueTwoFactor(req) {
    const code = generateTwoFactorCode();
    if (!req.session.twoFactor) {
        req.session.twoFactor = {
            email: { code: null, expiresAt: null },
            emailVerified: false
        };
    }

    const expiresAt = Date.now() + 5 * 60 * 1000;
    req.session.twoFactor.email = { code, expiresAt };
    req.session.twoFactor.stage = 'email';
    try {
        await sendEmail({
            to: req.session.user?.email,
            subject: "Your HomeBitez 2FA code",
            text: `Your HomeBitez verification code is ${code}. It expires in 5 minutes.`
        });
    } catch (err) {
        console.error("2FA email send failed:", err);
        req.flash('error', 'Failed to send 2FA email. Please try again.');
    }
    return code;
}

async function startSessionForUser(req, user) {
    await UsersModel.ensurePointsColumn();
    const userPoints = Number(user.points || 0);
    req.session.user = {
        id: user.id || user.user_id,
        email: user.email,
        username: user.username,
        role: user.role || 'user',
        avatar: user.avatar || '/images/default-avatar.png',
        address: user.address || '',
        contact: user.contact || '',
        points: userPoints,
        twoFactorVerified: false
    };

    if (req.session.user.role === 'biz_owner') req.session.post2faRedirect = '/bizowner';
    else if (req.session.user.role === 'admin') req.session.post2faRedirect = '/admin';
    else req.session.post2faRedirect = '/menu';

    issueTwoFactor(req);

    try {
        const cartRows = await CartModel.getByUserId(req.session.user.id);
        req.session.cart = cartRows.map(r => ({
            name: r.name,
            price: Number(r.price || 0),
            quantity: Number(r.quantity || 0),
            image: r.image || ""
        }));
    } catch (err) {
        console.error("Failed to load cart from DB:", err);
    }
}

function extractEmail(profile) {
    const email = profile?.emails?.[0]?.value;
    return email ? String(email).toLowerCase() : null;
}

async function upsertOAuthUser(provider, profile) {
    await UsersModel.ensureOAuthColumns();

    const oauthId = profile?.id ? String(profile.id) : null;
    const email = extractEmail(profile);
    const displayName = profile?.displayName || (email ? email.split('@')[0] : null);
    const avatar = profile?.photos?.[0]?.value || null;

    if (!oauthId) {
        return { error: "OAuth provider did not return a user id." };
    }
    if (!email) {
        return { error: "Your OAuth provider did not return an email address." };
    }

    let user = await UsersModel.findByOAuth(provider, oauthId);
    if (user) {
        if (!user.email || user.email.toLowerCase() !== email) {
            await UsersModel.linkOAuthToUser(user.id, { provider, oauthId, avatar, email, username: displayName });
            user = await UsersModel.findByOAuth(provider, oauthId);
        }
        return user;
    }

    const existing = await UsersModel.findByEmail(email);
    if (existing) {
        if (existing.oauth_provider && existing.oauth_provider !== provider) {
            return { error: "This email is already linked to a different login provider." };
        }
        if (existing.oauth_id && existing.oauth_id !== oauthId) {
            return { error: "This email is already linked to another account." };
        }
        await UsersModel.linkOAuthToUser(existing.id, { provider, oauthId, avatar, email, username: existing.username || displayName });
        return await UsersModel.findByEmail(email);
    }

    await UsersModel.createOAuthUser({
        username: displayName || `user_${provider}`,
        email,
        oauth_provider: provider,
        oauth_id: oauthId,
        avatar
    });
    return await UsersModel.findByEmail(email);
}

const appBaseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
const hasGoogleOAuth = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const hasFacebookOAuth = !!(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET);

if (hasGoogleOAuth) {
    passport.use(new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: `${appBaseUrl}/auth/google/callback`
    }, async (_accessToken, _refreshToken, profile, done) => {
        try {
            const user = await upsertOAuthUser('google', profile);
            if (user?.error) return done(null, false, { message: user.error });
            return done(null, user);
        } catch (err) {
            return done(err);
        }
    }));
}

if (hasFacebookOAuth) {
    passport.use(new FacebookStrategy({
        clientID: process.env.FACEBOOK_APP_ID,
        clientSecret: process.env.FACEBOOK_APP_SECRET,
        callbackURL: `${appBaseUrl}/auth/facebook/callback`,
        profileFields: ['id', 'displayName', 'photos', 'email']
    }, async (_accessToken, _refreshToken, profile, done) => {
        try {
            const user = await upsertOAuthUser('facebook', profile);
            if (user?.error) return done(null, false, { message: user.error });
            return done(null, user);
        } catch (err) {
            return done(err);
        }
    }));
}

const DAILY_TOPUP_LIMIT = 1000;

async function getDailyTopupTotal(userId) {
    try {
        await ensureWalletTransactionsTable();
        const [sumRows] = await db.query(
            "SELECT COALESCE(SUM(amount),0) AS total FROM wallet_transactions WHERE user_id=? AND type='topup' AND DATE(created_at)=CURDATE()",
            [userId]
        );
        return Number(sumRows?.[0]?.total || 0);
    } catch (err) {
        console.error("wallet daily topup error:", err);
        return 0;
    }
}

async function checkDailyTopupLimit(userId, amount) {
    const dailyTopup = await getDailyTopupTotal(userId);
    if (dailyTopup + amount > DAILY_TOPUP_LIMIT) {
        return { ok: false, dailyTopup, limit: DAILY_TOPUP_LIMIT };
    }
    return { ok: true, dailyTopup, limit: DAILY_TOPUP_LIMIT };
}

// Legacy fallback metadata so existing menu items still show badges/tags
// even before biz owners set per-product values from the add/edit form.
const DEFAULT_PRODUCT_META = {
    "curry": {
        bestSeller: true,
        discountPercent: 20,
        dietaryTags: ["Spicy"],
        allergenTags: ["Contains Beef"]
    },
    "shrimp fried rice": {
        bestSeller: true,
        dietaryTags: ["Spicy"],
        allergenTags: ["Shellfish"]
    },
    "nasi lemak": {
        bestSeller: true,
        dietaryTags: ["Spicy"],
        allergenTags: ["Egg"]
    },
    "papaya salad": {
        dietaryTags: ["Spicy", "Vegetarian"],
        allergenTags: []
    },
    "pandan chiffon cake": {
        dietaryTags: ["Vegetarian"],
        allergenTags: ["Egg", "Dairy", "Gluten"]
    },
    "pho": {
        dietaryTags: ["Contains Beef"],
        allergenTags: ["Gluten"]
    },
    "bagel": {
        dietaryTags: ["Vegetarian"],
        allergenTags: ["Gluten"]
    },
    "strawberry matcha": {
        dietaryTags: ["Vegetarian"],
        allergenTags: ["Dairy"]
    }
};

function getDefaultProductMeta(productName) {
    const key = String(productName || "").trim().toLowerCase();
    if (DEFAULT_PRODUCT_META[key]) return DEFAULT_PRODUCT_META[key];
    if (key.includes("curry")) return DEFAULT_PRODUCT_META["curry"];
    return {};
}

function toUniqueTags(tags) {
    return [...new Set((tags || []).map(t => String(t || "").trim()).filter(Boolean))];
}

function parseTags(value) {
    if (Array.isArray(value)) return toUniqueTags(value);
    return toUniqueTags(String(value || "").split(","));
}

function clampDiscount(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(90, Number(n.toFixed(2))));
}

function enrichProductForDisplay(product) {
    const fallback = getDefaultProductMeta(product.productName);
    const basePrice = Number(product.price || 0);
    const dbDiscount = Number(product.discountPercent);
    const hasDbDiscount = Number.isFinite(dbDiscount) && dbDiscount > 0;
    const discountPercent = hasDbDiscount
        ? clampDiscount(dbDiscount)
        : clampDiscount(fallback.discountPercent || 0);
    const finalPrice = discountPercent > 0
        ? Number((basePrice * (1 - discountPercent / 100)).toFixed(2))
        : Number(basePrice.toFixed(2));

    const dbDietary = parseTags(product.dietaryTags);
    const dbAllergen = parseTags(product.allergenTags);
    const fallbackDietary = toUniqueTags(fallback.dietaryTags || []);
    const fallbackAllergen = toUniqueTags(fallback.allergenTags || []);

    return {
        ...product,
        isBestSeller: Boolean(Number(product.isBestSeller || 0)) || Boolean(fallback.bestSeller),
        discountPercent,
        originalPrice: Number(basePrice.toFixed(2)),
        finalPrice,
        dietaryTags: dbDietary.length ? dbDietary : fallbackDietary,
        allergenTags: dbAllergen.length ? dbAllergen : fallbackAllergen
    };
}

function enrichProductsForDisplay(products) {
    return (products || []).map(enrichProductForDisplay);
}

function getSelectedCartItemsFromSession(session) {
    const cart = session?.cart || [];
    const selected = Array.isArray(session?.checkoutSelection) ? session.checkoutSelection : [];
    if (!selected.length) return cart;
    const set = new Set(selected.map(String));
    return cart.filter(i => set.has(i.name));
}

function getRedeemForSubtotalFromSession(session, subtotal) {
    const redeemAmount = Math.min(Number(subtotal || 0), Number(session?.cartRedeem?.amount || 0));
    const redeemPoints = Math.min(
        Number(session?.cartRedeem?.points || 0),
        Math.floor(redeemAmount / 0.1)
    );
    return {
        redeemAmount: Number(redeemAmount.toFixed(2)),
        redeemPoints: Number(redeemPoints || 0)
    };
}


// Public routes allowed without login
const publicPaths = [
    '/',
    '/menu',
    '/contact',
    '/report',
    '/chatbot',
    '/login',
    '/register',
    '/signup',
    '/auth/google',
    '/auth/google/callback',
    '/auth/facebook',
    '/auth/facebook/callback',
    '/logout',
    '/forgot-password',
    '/reset-password',
    '/about'
];

app.use((req, res, next) => {
    const user = req.session.user;
    const path = req.path;

    // allow static assets and favicon (already handled, but keep explicit)
    if (path.startsWith('/public') || path.startsWith('/images') || path === '/favicon.ico') {
        return next();
    }

    const isPublic = publicPaths.some(p => path === p || path.startsWith(p + '/'));
    if (!user && !isPublic) {
        if (req.flash) req.flash('error', 'Please login or register to continue.');
        return res.redirect('/login');
    }
    next();
});

// Two-factor gate
app.use((req, res, next) => {
    const user = req.session.user;
    const path = req.path;

    if (!user || user.twoFactorVerified) return next();
    if (path.startsWith('/2fa') || path.startsWith('/logout')) return next();
    if (path.startsWith('/public') || path.startsWith('/images') || path === '/favicon.ico') return next();

    const tf = req.session.twoFactor || {};
    if (!tf.emailVerified) return res.redirect('/2fa/email');
    return next();
});

// EJS setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

/* -------------------- MULTER (Image Uploads) -------------------- */
const multer = require("multer");

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, "public/images");
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + "-" + file.originalname);
    }
});

const upload = multer({ storage });
module.exports.upload = upload;

/* -------------------- ROUTES -------------------- */

// OAuth routes
app.get('/auth/google', (req, res, next) => {
    if (!hasGoogleOAuth) {
        req.flash('error', 'Google login is not configured yet.');
        return res.redirect('/login');
    }
    return passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

app.get('/auth/google/callback', (req, res, next) => {
    if (!hasGoogleOAuth) {
        req.flash('error', 'Google login is not configured yet.');
        return res.redirect('/login');
    }
    passport.authenticate('google', { session: false }, async (err, user, info) => {
        if (err) {
            console.error('Google OAuth error:', err);
            req.flash('error', err.message || 'Google login failed.');
            return res.redirect('/login');
        }
        if (!user) {
            const message = info?.message || 'Google login failed.';
            req.flash('error', message);
            return res.redirect('/login');
        }
        try {
            await startSessionForUser(req, user);
            return res.redirect('/2fa/email');
        } catch (sessionErr) {
            console.error('Google session error:', sessionErr);
            req.flash('error', 'Google login failed.');
            return res.redirect('/login');
        }
    })(req, res, next);
});

app.get('/auth/facebook', (req, res, next) => {
    if (!hasFacebookOAuth) {
        req.flash('error', 'Facebook login is not configured yet.');
        return res.redirect('/login');
    }
    return passport.authenticate('facebook', { scope: ['email'] })(req, res, next);
});

app.get('/auth/facebook/callback', (req, res, next) => {
    if (!hasFacebookOAuth) {
        req.flash('error', 'Facebook login is not configured yet.');
        return res.redirect('/login');
    }
    passport.authenticate('facebook', { session: false }, async (err, user, info) => {
        if (err) {
            console.error('Facebook OAuth error:', err);
            req.flash('error', err.message || 'Facebook login failed.');
            return res.redirect('/login');
        }
        if (!user) {
            const message = info?.message || 'Facebook login failed.';
            req.flash('error', message);
            return res.redirect('/login');
        }
        try {
            await startSessionForUser(req, user);
            return res.redirect('/2fa/email');
        } catch (sessionErr) {
            console.error('Facebook session error:', sessionErr);
            req.flash('error', 'Facebook login failed.');
            return res.redirect('/login');
        }
    })(req, res, next);
});

// Home
app.get('/', (req, res) => {
    res.render('index', { user: req.session.user || null });
});

// Logout route
app.get('/logout', (req, res) => {
  // If using express-session
  req.session.destroy(err => {
    if (err) {
      console.error('Error destroying session:', err);
      return res.redirect('/'); // fallback to home
    }
    // Clear the cookie (optional, if using cookies)
    res.clearCookie('connect.sid'); 
    // Redirect to homepage
    res.redirect('/');
  });
});


// Report Issue page
app.get('/report', async (req, res) => {
    if (!req.session.user) {
        req.flash('error', 'Please log in to submit a report.');
        return res.redirect('/login');
    }

    const userId = req.session.user.id;
    const userEmail = req.session.user.email || '';

    try {
        await ensureReportReplyColumns();
        const [rows] = await db.query(
            "SELECT id, subject, description, status, created_at, admin_reply, replied_at, user_reply, user_reply_at, order_id, address, image_url FROM report_messages WHERE user_id = ? ORDER BY created_at DESC",
            [userId]
        );
        const userOrders = await OrdersModel.listByUser(userId, 200);
        const orderOptions = (userOrders || []).map(o => {
            const labelBase = `ORD-${o.id}`;
            const paypalRef = o.paypal_order_id ? ` - PayPal ${o.paypal_order_id}` : '';
            return { value: String(o.id), label: `${labelBase}${paypalRef}` };
        });

        res.render('report', {
            success: req.flash('success'),
            error: req.flash('error'),
            userEmail,
            userAddress: req.session.user?.address || req.session.cartPrefs?.address || '',
            orderId: req.session.lastReceiptOrderId ? String(req.session.lastReceiptOrderId) : '',
            orderOptions,
            issues: rows || []
        });
    } catch (err) {
        console.error("Report list error:", err);
        res.render('report', {
            success: req.flash('success'),
            error: req.flash('error'),
            userEmail,
            userAddress: req.session.user?.address || req.session.cartPrefs?.address || '',
            orderId: req.session.lastReceiptOrderId ? String(req.session.lastReceiptOrderId) : '',
            orderOptions: [],
            issues: []
        });
    }
});

app.get('/refund', async (req, res) => {
    if (!req.session.user) {
        req.flash('error', 'Please log in to request a refund.');
        return res.redirect('/login');
    }

    const userId = req.session.user.id;
    const userEmail = req.session.user.email || '';
    const userName = req.session.user.username || req.session.user.name || '';

    try {
        await ensureRefundTable();
        const [rows] = await db.query(
            "SELECT id, order_id, amount, reason, refund_method, details, status, created_at FROM refund_requests WHERE user_id = ? ORDER BY created_at DESC",
            [userId]
        );
        const userOrders = await OrdersModel.listByUser(userId, 200);
        const orderOptions = (userOrders || []).map(o => {
            const labelBase = `ORD-${o.id}`;
            const paypalRef = o.paypal_order_id ? ` - PayPal ${o.paypal_order_id}` : '';
            return { value: String(o.id), label: `${labelBase}${paypalRef}` };
        });

        res.render('refund', {
            success: req.flash('success'),
            error: req.flash('error'),
            userEmail,
            userName,
            orderOptions,
            refunds: rows || []
        });
    } catch (err) {
        console.error("Refund list error:", err);
        res.render('refund', {
            success: req.flash('success'),
            error: req.flash('error'),
            userEmail,
            userName,
            orderOptions: [],
            refunds: []
        });
    }
});

app.post('/refund', async (req, res) => {
    if (!req.session.user) {
        req.flash('error', 'Please log in to request a refund.');
        return res.redirect('/login');
    }

    const { name, orderId, reason, details, refundMethod } = req.body;
    const email = req.session.user.email || '';
    const cleanName = (name || '').trim();
    const cleanReason = (reason || '').trim();
    const cleanDetails = (details || '').trim();
    const cleanRefundMethod = (refundMethod || '').trim();
    const orderIdNum = Number(orderId);
    const amountNum = 0;

    if (!cleanName || !email || !Number.isFinite(orderIdNum) || !cleanReason || !cleanDetails) {
        req.flash('error', 'Please fill out all fields.');
        return res.redirect('/refund');
    }
    if (!['original', 'wallet'].includes(cleanRefundMethod)) {
        req.flash('error', 'Please choose a refund method.');
        return res.redirect('/refund');
    }

    try {
        await ensureRefundTable();
        const userOrders = await OrdersModel.listByUser(req.session.user.id, 200);
        const allowedIds = new Set((userOrders || []).map(o => String(o.id)));
        if (!allowedIds.has(String(orderIdNum))) {
            req.flash('error', 'Order ID must be one of your own orders.');
            return res.redirect('/refund');
        }

        await db.query(
            "INSERT INTO refund_requests (user_id, order_id, name, email, amount, reason, refund_method, details) VALUES (?,?,?,?,?,?,?,?)",
            [req.session.user.id, orderIdNum, cleanName, email, amountNum, cleanReason, cleanRefundMethod, cleanDetails]
        );
        req.flash('success', 'Refund request submitted.');
        return res.redirect('/refund');
    } catch (err) {
        console.error("Refund submit error:", err);
        req.flash('error', 'Failed to submit refund request.');
        return res.redirect('/refund');
    }
});

app.post('/report', upload.single('issueImage'), async (req, res) => {
    if (!req.session.user) {
        req.flash('error', 'Please log in to submit a report.');
        return res.redirect('/login');
    }

    const { name, subject, description, orderId, address } = req.body;
    const email = req.session.user.email || '';
    const cleanOrderId = (orderId || '').trim();
    const cleanAddress = (address || '').trim();

    if (!name || !email || !subject || !description || !cleanOrderId || !cleanAddress) {
        req.flash('error', 'Please fill out all fields, including order ID and address.');
        return res.redirect('/report');
    }

    try {
        const orderIdNum = Number(cleanOrderId);
        if (!Number.isFinite(orderIdNum)) {
            req.flash('error', 'Please select a valid order ID.');
            return res.redirect('/report');
        }
        const userOrders = await OrdersModel.listByUser(req.session.user.id, 200);
        const allowedIds = new Set((userOrders || []).map(o => String(o.id)));
        if (!allowedIds.has(String(orderIdNum))) {
            req.flash('error', 'Order ID must be one of your own orders.');
            return res.redirect('/report');
        }

        const imageUrl = req.file ? `/images/${req.file.filename}` : null;
        await ReportModel.create({
            userId: req.session.user.id || null,
            name,
            email,
            subject,
            description,
            orderId: String(orderIdNum),
            address: cleanAddress,
            imageUrl
        });

        req.flash('success', 'Report submitted successfully.');
        res.redirect('/report');
    } catch (err) {
        console.error(err);
        req.flash('error', 'Failed to submit report.');
        res.redirect('/report');
    }
});

// User mark report as resolved
app.post('/report/:id/resolve', async (req, res) => {
    if (!req.session.user) {
        req.flash('error', 'Please log in to continue.');
        return res.redirect('/login');
    }

    const reportId = Number(req.params.id);
    if (!Number.isFinite(reportId)) {
        req.flash('error', 'Invalid report ID.');
        return res.redirect('/report');
    }

    try {
        await ensureReportReplyColumns();
        await db.query(
            "UPDATE report_messages SET status = 'resolved' WHERE id = ? AND user_id = ?",
            [reportId, req.session.user.id]
        );
        req.flash('success', 'Issue marked as resolved.');
    } catch (err) {
        console.error('Report resolve error:', err);
        req.flash('error', 'Failed to update issue status.');
    }

    return res.redirect('/report');
});

app.post('/report/:id/reply', async (req, res) => {
    if (!req.session.user) {
        req.flash('error', 'Please log in to continue.');
        return res.redirect('/login');
    }

    const reportId = Number(req.params.id);
    const reply = (req.body.reply || '').trim();
    if (!Number.isFinite(reportId) || !reply) {
        req.flash('error', 'Reply cannot be empty.');
        return res.redirect('/report');
    }

    try {
        await ensureReportReplyColumns();
        await db.query(
            "UPDATE report_messages SET user_reply = ?, user_reply_at = NOW(), status = 'in_progress' WHERE id = ? AND user_id = ?",
            [reply, reportId, req.session.user.id]
        );
        req.flash('success', 'Reply sent to admin.');
    } catch (err) {
        console.error('User reply error:', err);
        req.flash('error', 'Failed to send reply.');
    }

    return res.redirect('/report');
});

// Auth
app.get('/login', UsersController.showLogin);
app.post('/login', UsersController.login);
app.get('/register', UsersController.showRegister);
app.post('/register', UsersController.register);
app.post('/signup', UsersController.register);

app.get('/forgot-password', (req, res) => {
    res.render('forgot-password', {
        success: req.flash('success'),
        error: req.flash('error')
    });
});

app.post('/forgot-password', async (req, res) => {
    const email = String(req.body.email || '').trim();
    if (!email) {
        req.flash('error', 'Please enter your email.');
        return res.redirect('/forgot-password');
    }

    const user = await UsersModel.findByEmail(email);
    if (user) {
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
        await UsersModel.createPasswordReset(user.id || user.user_id, token, expiresAt);

        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const resetLink = `${baseUrl}/reset-password?token=${token}`;
        console.log('Password reset link for', email, ':', resetLink);
    }

    req.flash('success', 'If that email exists, a reset link was sent.');
    return res.redirect('/forgot-password');
});

app.get('/reset-password', async (req, res) => {
    const token = String(req.query.token || '');
    let validToken = '';
    if (token) {
        const reset = await UsersModel.findValidPasswordReset(token);
        if (reset) validToken = token;
    }

    if (!validToken) {
        req.flash('error', 'Reset link is invalid or expired.');
    }

    res.render('reset-password', {
        token: validToken,
        success: req.flash('success'),
        error: req.flash('error')
    });
});

app.post('/reset-password', async (req, res) => {
    const token = String(req.body.token || '');
    const newPassword = String(req.body.newPassword || '');
    const confirmPassword = String(req.body.confirmPassword || '');

    if (!token) {
        req.flash('error', 'Reset link is invalid or expired.');
        return res.redirect('/reset-password');
    }

    const reset = await UsersModel.findValidPasswordReset(token);
    if (!reset) {
        req.flash('error', 'Reset link is invalid or expired.');
        return res.redirect('/reset-password');
    }

    if (!newPassword || newPassword !== confirmPassword) {
        req.flash('error', 'Passwords do not match.');
        return res.redirect(`/reset-password?token=${encodeURIComponent(token)}`);
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await UsersModel.updatePassword(reset.user_id, hashed);
    await UsersModel.markPasswordResetUsed(reset.id);

    req.flash('success', 'Password reset successful. Please log in.');
    return res.redirect('/login');
});


app.get('/2fa/email', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    const tf = req.session.twoFactor || {};
    const email = tf.email || {};
    if (!email.code || (email.expiresAt && Date.now() > email.expiresAt)) {
        await issueTwoFactor(req);
    }

    res.render('2fa-email', {
        error: req.flash('error'),
        success: req.flash('success'),
        maskedEmail: maskEmail(req.session.user.email)
    });
});

app.post('/2fa/email/verify', (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    const submitted = String(req.body.code || '').replace(/\s/g, '');
    const tf = req.session.twoFactor || {};
    const email = tf.email || {};

    if (!email.code) {
        req.flash('error', 'Verification code not found. Please resend.');
        return res.redirect('/2fa/email');
    }

    if (email.expiresAt && Date.now() > email.expiresAt) {
        req.flash('error', 'Code expired. Please resend.');
        return res.redirect('/2fa/email');
    }

    if (submitted != String(email.code)) {
        req.flash('error', 'Invalid code. Please try again.');
        return res.redirect('/2fa/email');
    }

    req.session.twoFactor.emailVerified = true;
    req.session.user.twoFactorVerified = true;
    req.session.twoFactor = null;
    const redirectTo = req.session.post2faRedirect || '/menu';
    req.session.post2faRedirect = null;
    return res.redirect(redirectTo);
});

app.post('/2fa/email/resend', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    await issueTwoFactor(req);
    return res.redirect('/2fa/email');
});

// Menu (requires login) - load products from DB and pass to view
app.get('/menu', async (req, res) => {
    try {
        const [rows] = await ProductModel.getAll();
        const products = enrichProductsForDisplay(rows || []);

        res.render('menu', {
            user: req.session.user || null,
            products
        });
    } catch (err) {
        console.error('Menu load error:', err);
        res.render('menu', { user: req.session.user || null, products: [] });
    }
});

app.get('/menu/product/:id', async (req, res) => {
    const productId = Number(req.params.id);
    if (!Number.isInteger(productId) || productId <= 0) {
        req.flash('error', 'Invalid product.');
        return res.redirect('/menu');
    }

    try {
        const [rows] = await ProductModel.getById(productId);
        const product = rows && rows[0] ? enrichProductForDisplay(rows[0]) : null;

        if (!product) {
            req.flash('error', 'Product not found.');
            return res.redirect('/menu');
        }

        return res.render('product', {
            user: req.session.user || null,
            product
        });
    } catch (err) {
        console.error('Product page load error:', err);
        req.flash('error', 'Unable to load product details.');
        return res.redirect('/menu');
    }
});


// Admin dashboard
app.get('/admin', async (req, res) => {
    if (!req.session.user) {
        req.flash('error', 'Please login first.');
        return res.redirect('/login');
    }
    if (req.session.user.role !== 'admin') {
        req.flash('error', 'Access denied.');
        return res.redirect('/menu');
    }

    let totalCustomers = 0;
    let totalOrders = 0;
    let totalProducts = 0;
    let totalIssues = 0;

    try {
        const [p] = await db.query("SELECT COUNT(*) AS total FROM product");
        totalProducts = p[0]?.total || 0;

        const [o] = await db.query("SELECT COUNT(*) AS total FROM orders");
        totalOrders = o[0]?.total || 0;

        const [c] = await db.query("SELECT COUNT(*) AS total FROM users WHERE role = 'user'");
        totalCustomers = c[0]?.total || 0;

        const [i] = await db.query("SELECT COUNT(*) AS total FROM report_messages");
        totalIssues = i[0]?.total || 0;
    } catch (err) {
        console.error("Admin stats error:", err);
    }

    res.render('admin', {
        stats: {
            totalCustomers,
            totalOrders,
            totalProducts,
            totalIssues
        },
        adminName: req.session.user?.username || 'Admin'
    });
});

// Admin profile
app.get('/admin/profile', async (req, res) => {
    if (!req.session.user) {
        req.flash('error', 'Please login first.');
        return res.redirect('/login');
    }
    if (req.session.user.role !== 'admin') {
        req.flash('error', 'Access denied.');
        return res.redirect('/menu');
    }

    try {
        const userId = req.session.user.id;
        const [rows] = await db.query("SELECT * FROM users WHERE id = ?", [userId]);
        const user = rows && rows[0] ? rows[0] : req.session.user;
        res.render('admin-profile', {
            user,
            success: req.flash('success'),
            error: req.flash('error'),
            adminName: req.session.user?.username || 'Admin'
        });
    } catch (err) {
        console.error("Admin profile page error:", err);
        req.flash('error', 'Failed to load profile.');
        return res.redirect('/admin');
    }
});

app.post('/admin/profile', async (req, res) => {
    if (!req.session.user) {
        req.flash('error', 'Please login first.');
        return res.redirect('/login');
    }
    if (req.session.user.role !== 'admin') {
        req.flash('error', 'Access denied.');
        return res.redirect('/menu');
    }

    try {
        const userId = req.session.user.id;
        const username = (req.body.username || '').trim();
        const email = (req.body.email || '').trim();
        const address = (req.body.address || '').trim();
        const contact = (req.body.contact || '').trim();

        await db.query(
            "UPDATE users SET username=?, email=?, address=?, contact=? WHERE id=?",
            [username, email, address, contact, userId]
        );

        // keep session in sync
        if (req.session.user) {
            req.session.user.username = username;
            req.session.user.email = email;
            req.session.user.address = address;
            req.session.user.contact = contact;
        }

        req.flash('success', 'Profile updated successfully.');
        return res.redirect('/admin/profile');
    } catch (err) {
        console.error("Admin profile update error:", err);
        req.flash('error', 'Failed to update profile.');
        return res.redirect('/admin/profile');
    }
});

// Admin manage customers
app.get('/admin/customers', async (req, res) => {
    if (!req.session.user) {
        req.flash('error', 'Please login first.');
        return res.redirect('/login');
    }
    if (req.session.user.role !== 'admin') {
        req.flash('error', 'Access denied.');
        return res.redirect('/menu');
    }

    let customers = [];
    try {
        await UsersModel.ensurePointsColumn();
        let rows = [];
        try {
            const [withPoints] = await db.query(
                "SELECT id, username, email, contact, IFNULL(points, 0) AS points FROM users WHERE role = 'user' ORDER BY id ASC"
            );
            rows = withPoints;
        } catch (err) {
            const [fallback] = await db.query(
                "SELECT id, username, email, contact FROM users WHERE role = 'user' ORDER BY id ASC"
            );
            rows = fallback.map(row => ({ ...row, points: 0 }));
        }
        customers = rows;
    } catch (err) {
        console.error("Admin customers error:", err);
    }

    res.render('admin-customers', {
        customers,
        adminName: req.session.user?.username || 'Admin',
        success: req.flash('success'),
        error: req.flash('error')
    });
});

// Admin inventory
app.get('/admin/inventory', async (req, res) => {
    if (!req.session.user) {
        req.flash('error', 'Please login first.');
        return res.redirect('/login');
    }
    if (req.session.user.role !== 'admin') {
        req.flash('error', 'Access denied.');
        return res.redirect('/menu');
    }

    let products = [];
    try {
        const [rows] = await db.query(
            `SELECT p.id, p.product_name AS productName, p.image, p.description, p.quantity, p.price, p.owner_id,
                    u.username AS businessName
             FROM product p
             LEFT JOIN users u ON u.id = p.owner_id
             ORDER BY p.id ASC`
        );
        products = rows;
    } catch (err) {
        console.error("Admin inventory error:", err);
    }

    res.render('admin-inventory', {
        products,
        adminName: req.session.user?.username || 'Admin'
    });
});


// Admin purchase records
app.get('/admin/records', async (req, res) => {
    if (!req.session.user) {
        req.flash('error', 'Please login first.');
        return res.redirect('/login');
    }
    if (req.session.user.role !== 'admin') {
        req.flash('error', 'Access denied.');
        return res.redirect('/menu');
    }

    let orders = [];
    let records = [];

    try {
        orders = await OrdersModel.list(200);
        const userIds = Array.from(
            new Set(
                (orders || [])
                    .map(o => Number(o.user_id))
                    .filter(id => Number.isFinite(id))
            )
        );

        const userMap = new Map();
        if (userIds.length) {
            const [rows] = await db.query(
                "SELECT id, username, email, contact FROM users WHERE id IN (?)",
                [userIds]
            );
            (rows || []).forEach(r => userMap.set(Number(r.id), r));
        }

        records = (orders || []).map(o => {
            const user = userMap.get(Number(o.user_id)) || {};
            const items = Array.isArray(o.items)
                ? o.items.map(it => {
                    const qty = Number(it.qty || it.quantity || 0) || 0;
                    const name = it.name || 'Item';
                    return `${qty}x ${name}`;
                  }).join(', ')
                : '';

            const status = o.status
                ? String(o.status)
                : (o.paypal_capture_id ? 'Completed' : 'Pending');

            return {
                id: o.id,
                name: o.shipping_name || user.username || '-',
                email: o.payer_email || user.email || '-',
                contact: user.contact || '-',
                items: items || '-',
                status,
                total: Number(o.total || 0),
                createdAt: o.created_at || null
            };
        });
    } catch (err) {
        console.error("Admin records error:", err);
    }

    res.render('admin-records', {
        records,
        adminName: req.session.user?.username || 'Admin'
    });
});

// Admin sales reports
app.get('/admin/reports', async (req, res) => {
    if (!req.session.user) {
        req.flash('error', 'Please login first.');
        return res.redirect('/login');
    }
    if (req.session.user.role !== 'admin') {
        req.flash('error', 'Access denied.');
        return res.redirect('/menu');
    }

    let totalRevenue = 0;
    let totalOrders = 0;
    let totalProducts = 0;
    let averageOrderValue = 0;
    let growthPercent = 0;
    let dailySales = [];
    let lowStock = [];
    let recentOrders = [];
    let salesByCategory = [];
    let bestSellers = [];
    let returningCustomers = [];

    try {
        // detect column names to support different schemas
        const [colRows] = await db.query(
            "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'"
        );
        const colSet = new Set((colRows || []).map(r => (r.COLUMN_NAME || '').toLowerCase()));
        const pick = (cands, fallback) => {
            for (const c of cands) if (colSet.has(c.toLowerCase())) return c;
            return fallback;
        };
        const totalCol = pick(['totalAmount', 'total', 'total_amount'], 'total');
        const createdCol = pick(['created_at', 'createdAt'], 'created_at');
        const userCol = pick(['user_id', 'userId', 'user'], 'user_id');
        const itemsCol = pick(['items', 'order_items', 'orderItems'], null);

        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const start7 = new Date(today);
        start7.setDate(start7.getDate() - 6);
        const startPrev7 = new Date(start7);
        startPrev7.setDate(startPrev7.getDate() - 7);

        // headline
        const [[revRow]] = await db.query(`SELECT COALESCE(SUM(${totalCol}),0) AS revenue, COUNT(*) AS cnt FROM orders`);
        totalRevenue = Number(revRow?.revenue || 0);
        totalOrders = Number(revRow?.cnt || 0);
        averageOrderValue = totalOrders ? totalRevenue / totalOrders : 0;

        const [[prodRow]] = await db.query("SELECT COUNT(*) AS total FROM product");
        totalProducts = Number(prodRow?.total || 0);

        // week growth
        const [[currentWeek]] = await db.query(
            `SELECT COALESCE(SUM(${totalCol}),0) AS revenue FROM orders WHERE ${createdCol} >= ? AND ${createdCol} < ?`,
            [start7, new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)]
        );
        const [[prevWeek]] = await db.query(
            `SELECT COALESCE(SUM(${totalCol}),0) AS revenue FROM orders WHERE ${createdCol} >= ? AND ${createdCol} < ?`,
            [startPrev7, start7]
        );
        const curRev = Number(currentWeek?.revenue || 0);
        const prevRev = Number(prevWeek?.revenue || 0);
        growthPercent = prevRev ? ((curRev - prevRev) / prevRev) * 100 : 0;

        // daily sales last 7 days
        const [dailyRows] = await db.query(
            `SELECT DATE(${createdCol}) AS d, COALESCE(SUM(${totalCol}),0) AS revenue, COUNT(*) AS orders
             FROM orders
             WHERE ${createdCol} >= ? AND ${createdCol} < ?
             GROUP BY d
             ORDER BY d ASC`,
            [start7, new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)]
        );
        const mapDaily = new Map();
        (dailyRows || []).forEach(r => mapDaily.set(r.d.toISOString().slice(0,10), { revenue: Number(r.revenue || 0), orders: Number(r.orders || 0) }));
        for (let i = 0; i < 7; i++) {
            const d = new Date(start7);
            d.setDate(start7.getDate() + i);
            const key = d.toISOString().slice(0,10);
            const entry = mapDaily.get(key) || { revenue: 0, orders: 0 };
            dailySales.push({ label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }), ...entry });
        }

        const [lowRows] = await db.query(
            "SELECT id, product_name AS name, quantity FROM product WHERE quantity < 10 ORDER BY quantity ASC LIMIT 5"
        );
        lowStock = lowRows || [];

        const [recentRows] = await db.query(
            `SELECT o.id, o.${totalCol} AS totalAmount, o.${createdCol} AS createdAt, o.status, u.username,
                    COALESCE(SUM(oi.quantity),0) AS items,
                    ${itemsCol ? `o.${itemsCol} AS itemsJson` : 'NULL AS itemsJson'}
             FROM orders o
             LEFT JOIN order_items oi ON oi.orderId = o.id
             LEFT JOIN users u ON u.id = o.${userCol}
             GROUP BY o.id
             ORDER BY o.${createdCol} DESC
             LIMIT 5`
        );
        recentOrders = (recentRows || []).map(r => ({
            id: r.id,
            total: Number(r.totalAmount || 0),
            date: r.createdAt,
            items: (() => {
                const fromJoin = Number(r.items || 0);
                if (fromJoin > 0) return fromJoin;
                if (r.itemsJson) {
                    try {
                        const arr = JSON.parse(r.itemsJson);
                        return arr.reduce((s, it) => s + Number(it.qty || it.quantity || 0), 0);
                    } catch (e) { return 0; }
                }
                return 0;
            })(),
            status: r.status || 'pending',
            customer: r.username || 'Guest'
        }));

        const [catRows] = await db.query(
            `SELECT p.category AS category, COALESCE(SUM(oi.quantity * oi.price),0) AS revenue
             FROM order_items oi
             JOIN product p ON p.id = oi.productId
             GROUP BY p.category
             ORDER BY revenue DESC`
        );
        salesByCategory = catRows || [];

        const [bestRows] = await db.query(
            `SELECT p.product_name AS name,
                    SUM(oi.quantity) AS qty,
                    SUM(oi.quantity * oi.price) AS revenue
             FROM order_items oi
             JOIN product p ON p.id = oi.productId
             GROUP BY p.id
             ORDER BY qty DESC
             LIMIT 5`
        );
        bestSellers = bestRows || [];

        const [retRows] = await db.query(
            `SELECT u.username, COUNT(o.id) AS orders, COALESCE(SUM(o.${totalCol}),0) AS spend
             FROM orders o
             JOIN users u ON u.id = o.${userCol}
             GROUP BY u.id
             HAVING orders > 1
             ORDER BY orders DESC, spend DESC
             LIMIT 5`
        );
        returningCustomers = retRows || [];
    } catch (err) {
        console.error("Admin reports error:", err);
    }

    res.render('admin-reports', {
        adminName: req.session.user?.username || 'Admin',
        totalRevenue,
        totalOrders,
        totalProducts,
        averageOrderValue,
        growthPercent,
        dailySales,
        lowStock,
        recentOrders,
        salesByCategory,
        bestSellers,
        returningCustomers,
        updatedAt: new Date().toLocaleString()
    });
});

// Admin delete customer
app.post('/admin/customers/:id/delete', async (req, res) => {
    if (!req.session.user) {
        req.flash('error', 'Please login first.');
        return res.redirect('/login');
    }
    if (req.session.user.role !== 'admin') {
        req.flash('error', 'Access denied.');
        return res.redirect('/menu');
    }

    const customerId = Number(req.params.id);
    if (!Number.isFinite(customerId)) {
        req.flash('error', 'Invalid customer ID.');
        return res.redirect('/admin/customers');
    }

    try {
        await db.query("DELETE FROM users WHERE id = ? AND role = 'user'", [customerId]);
        req.flash('success', 'Customer account terminated.');
    } catch (err) {
        console.error("Admin delete customer error:", err);
        req.flash('error', 'Failed to terminate account.');
    }

    return res.redirect('/admin/customers');
});

// Admin issues reported
app.get('/admin/issues', async (req, res) => {
    if (!req.session.user) {
        req.flash('error', 'Please login first.');
        return res.redirect('/login');
    }
    if (req.session.user.role !== 'admin') {
        req.flash('error', 'Access denied.');
        return res.redirect('/menu');
    }

    let issues = [];
    try {
        await ensureReportReplyColumns();
        const [rows] = await db.query(
            `SELECT rm.id, rm.name, rm.email, rm.subject, rm.description, rm.status, rm.created_at,
                    rm.admin_reply, rm.replied_at, rm.user_reply, rm.user_reply_at, rm.order_id, rm.address, rm.image_url, u.contact
             FROM report_messages rm
             LEFT JOIN users u ON u.id = rm.user_id
             ORDER BY rm.created_at DESC`
        );
        issues = rows;
    } catch (err) {
        console.error("Admin issues error:", err);
    }

    res.render('admin-issues', {
        issues,
        adminName: req.session.user?.username || 'Admin',
        success: req.flash('success'),
        error: req.flash('error')
    });
});

app.post('/admin/issues/:id/reply', async (req, res) => {
    if (!req.session.user) {
        req.flash('error', 'Please login first.');
        return res.redirect('/login');
    }
    if (req.session.user.role !== 'admin') {
        req.flash('error', 'Access denied.');
        return res.redirect('/menu');
    }

    const issueId = Number(req.params.id);
    const reply = (req.body.reply || '').trim();
    if (!Number.isFinite(issueId) || !reply) {
        req.flash('error', 'Reply cannot be empty.');
        return res.redirect('/admin/issues');
    }

    try {
        await ensureReportReplyColumns();
        await db.query(
            "UPDATE report_messages SET admin_reply = ?, replied_at = NOW(), replied_by = ? WHERE id = ?",
            [reply, req.session.user.id, issueId]
        );
        req.flash('success', 'Reply sent.');
    } catch (err) {
        console.error("Admin reply error:", err);
        req.flash('error', 'Failed to send reply.');
    }

    return res.redirect('/admin/issues');
});

app.post('/admin/issues/:id/resolve', async (req, res) => {
    if (!req.session.user) {
        req.flash('error', 'Please login first.');
        return res.redirect('/login');
    }
    if (req.session.user.role !== 'admin') {
        req.flash('error', 'Access denied.');
        return res.redirect('/menu');
    }

    const issueId = Number(req.params.id);
    if (!Number.isFinite(issueId)) {
        req.flash('error', 'Invalid issue ID.');
        return res.redirect('/admin/issues');
    }

    try {
        await ensureReportReplyColumns();
        await db.query(
            "UPDATE report_messages SET status = 'resolved' WHERE id = ?",
            [issueId]
        );
        req.flash('success', 'Issue marked as resolved.');
    } catch (err) {
        console.error("Admin resolve error:", err);
        req.flash('error', 'Failed to update issue status.');
    }

    return res.redirect('/admin/issues');
});

// Logout
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

// GET user profile
app.get('/user/profile', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const userId = req.session.user.id;
  let user = req.session.user;

  try {
    await UsersModel.ensurePointsColumn();
    await UsersModel.ensurePointsHistoryTable();
    const userRows = await UsersModel.findById(userId);
    const dbUser = Array.isArray(userRows) ? userRows[0] : userRows;
    const points = await UsersModel.getPoints(userId);
    let pointsHistory = await UsersModel.getPointsHistory(userId, 20);
    // Compute running balance from oldest to newest
    const computeWithBalance = (list) => {
      let running = 0;
      return (list || []).map(h => {
        running += Number(h.points || 0);
        return { ...h, balanceAfter: running };
      });
    };

    let enrichedHistory = computeWithBalance(pointsHistory);

    // If DB history is empty but session has recent entries (newest-first), compute from session copy
    if ((!enrichedHistory || enrichedHistory.length === 0) && Array.isArray(req.session.user.pointsHistory) && req.session.user.pointsHistory.length) {
      enrichedHistory = computeWithBalance((req.session.user.pointsHistory || []).slice().reverse());
    }

    if ((!enrichedHistory || enrichedHistory.length === 0) && points > 0) {
      enrichedHistory.push({
        date: '�',
        desc: 'Existing balance',
        points,
        balanceAfter: points
      });
    }
    // Show newest first
    enrichedHistory = enrichedHistory.slice().reverse();
    if (dbUser) {
      user = {
        ...user,
        username: dbUser.username || user.username,
        email: dbUser.email || user.email,
        address: dbUser.address || user.address,
        contact: dbUser.contact || user.contact,
        avatar: dbUser.avatar || user.avatar || '/images/default-avatar.png',
        points,
        pointsHistory: enrichedHistory
      };
      req.session.user = user;
    } else {
      user = { ...user, points, pointsHistory: enrichedHistory };
      req.session.user = user;
    }
  } catch (err) {
    console.error('Profile points load error:', err);
  }

  // Pull recent orders for this user
  let orders = [];
  try {
    const rawOrders = await OrdersModel.listByUser(userId, 50);
    const timeZone = process.env.APP_TIMEZONE || "Asia/Singapore";
    const normalizeStatus = (s) => s ? (s.charAt(0).toUpperCase() + s.slice(1)) : null;
    const formatOrderDate = (value) => {
      if (!value) return "-";
      let d;
      if (value instanceof Date) {
        d = value;
      } else if (typeof value === "string") {
        const s = value.trim();
        if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(s)) {
          d = new Date(s.replace(" ", "T") + "Z");
        } else {
          d = new Date(s);
        }
      } else {
        d = new Date(value);
      }
      return d.toLocaleString("en-SG", { timeZone });
    };
    orders = rawOrders.map(o => {
      const qty = (o.items || []).reduce((s, i) => s + Number(i.qty || i.quantity || 0), 0);
      const derivedStatus = normalizeStatus(o.status) || (o.paypal_capture_id ? 'Paid' : 'Pending');
      return {
        orderId: o.paypal_order_id || `ORD-${o.id}`,
        date: formatOrderDate(o.created_at),
        qty,
        total: Number(o.total || 0),
        status: derivedStatus
      };
    });
  } catch (err) {
    console.error('profile history error:', err);
    orders = [];
  }

  // Pull reported issues for this user
  let userIssues = [];
  try {
    await ensureReportReplyColumns();
    const [rows] = await db.query(
      "SELECT id, subject, description, status, created_at, admin_reply, replied_at, user_reply, user_reply_at, order_id, address, image_url FROM report_messages WHERE user_id = ? ORDER BY created_at DESC",
      [userId]
    );
    userIssues = rows || [];
  } catch (err) {
    console.error('profile issues load error:', err);
    userIssues = [];
  }

  // Pull messages sent to this user (bizowner replies)
  let userMessages = [];
  try {
    await ensureMessagesTable();
    const [rows] = await db.query(
      `SELECT m.id, m.senderId, m.ownerId, m.message, m.isRead, m.created_at,
              u.username AS senderName, u.email AS senderEmail
       FROM messages m
       LEFT JOIN users u ON u.id = m.senderId
       WHERE m.ownerId = ?
       ORDER BY m.created_at DESC`,
      [userId]
    );
    userMessages = rows || [];
  } catch (err) {
    console.error('profile messages load error:', err);
    userMessages = [];
  }

  res.render('userprofile', { 
      user, 
      orders,
      userIssues,
      userMessages,
      success: req.flash('success'),
      error: req.flash('error')
  });
});


// POST update profile
app.post('/user/profile', upload.single('avatar'), async (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  try {
    const { username, email, address, contact } = req.body;
    let avatarPath = req.session.user.avatar || '/images/default-avatar.png';

    if (req.file) {
      avatarPath = '/images/' + req.file.filename;
    }

    // Update user in DB
    await db.query(
      'UPDATE users SET username=?, email=?, address=?, contact=?, avatar=? WHERE id=?',
      [username, email, address, contact, avatarPath, req.session.user.id]
    );

    // Update session
    req.session.user = { ...req.session.user, username, email, address, contact, avatar: avatarPath };

    req.flash('success', 'Profile updated successfully.');
    res.redirect('/user/profile');
  } catch (err) {
    console.error('Profile update error:', err);
    req.flash('error', 'Failed to update profile.');
    res.redirect('/user/profile');
  }
});

// GET Contact Us page (PUBLIC)
app.get('/contact', (req, res) => {
    res.render('contact', {
        error: req.flash('error'),
        success: req.flash('success'),
        userEmail: req.session.user ? req.session.user.email : '',
        isLoggedIn: !!req.session.user
    });
});


// POST Contact Us form (LOGIN REQUIRED)
app.post('/contact', async (req, res) => {
    if (!req.session.user) {
        req.flash('error', 'Please log in to send a message.');
        return res.redirect('/login');
    }

    const { name, email, message } = req.body;

    if (!name || !email || !message) {
        req.flash('error', 'Please fill in all fields.');
        return res.redirect('/contact');
    }

    try {
        await ensureMessagesTable();
        const ownerId = null; // unassigned; biz owners will still see it due to fallback logic
        await db.query(
            'INSERT INTO messages (senderId, ownerId, message, isRead, created_at) VALUES (?, ?, ?, 0, NOW())',
            [req.session.user.id, ownerId, message]
        );

        req.flash('success', 'Your message has been sent!');
        res.redirect('/contact');
    } catch (err) {
        console.error(err);
        req.flash('error', 'Failed to send message.');
        res.redirect('/contact');
    }
});



// POST change password
app.post('/user/change-password', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const { currentPassword, newPassword, confirmPassword } = req.body;
  const userId = req.session.user.id;

  if (!currentPassword || !newPassword || !confirmPassword) {
    req.flash('error', 'Please fill in all password fields.');
    return res.redirect('/user/profile');
  }

  if (newPassword !== confirmPassword) {
    req.flash('error', 'New passwords do not match.');
    return res.redirect('/user/profile');
  }

  try {
    // Fetch user from DB
    const [rows] = await db.query('SELECT * FROM users WHERE id = ?', [userId]);
    if (rows.length === 0) {
      req.flash('error', 'User not found.');
      return res.redirect('/user/profile');
    }

    const user = rows[0];

    // Compare password with bcrypt
    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) {
      req.flash('error', 'Current password is incorrect.');
      return res.redirect('/user/profile');
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE users SET password=? WHERE id=?', [hashedPassword, userId]);

    req.flash('success', 'Password updated successfully!');
    res.redirect('/user/profile');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Error changing password.');
    res.redirect('/user/profile');
  }
});




/* -------------------- CART ROUTES -------------------- */
const cartRoutes = require("./Routes/cartRoutes");
app.use("/cart", cartRoutes);

/* -------------------- About Us -------------------- */
app.get("/about", (req, res) => {
  res.render("about");
});


/* -------------------- CHECKOUT ROUTES -------------------- */
const checkoutRoutes = require("./Routes/checkoutRoutes");
app.use(checkoutRoutes);

/* -------------------- CHATBOT ROUTES -------------------- */
const chatbotRoutes = require("./Routes/chatbotRoutes");
app.use(chatbotRoutes);


/* -------------------- NETS QR -------------------- */
app.get("/nets-qr/fail", (req, res) => {
    res.render("netsQrFail", { errorMsg: "Payment failed. Please try again." });
});

app.get("/sse/payment-status/:txnRetrievalRef", async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const txnRetrievalRef = req.params.txnRetrievalRef;
    if (!txnRetrievalRef) {
        res.write(`data: ${JSON.stringify({ error: true })}\n\n`);
        return res.end();
    }

    const interval = setInterval(async () => {
        try {
            const result = await nets.checkStatus(txnRetrievalRef);
            const status = result?.status || "PENDING";

            if (status === "SUCCESS") {
                res.write(`data: ${JSON.stringify({ success: true })}\n\n`);
                clearInterval(interval);
                return res.end();
            }

            if (status === "FAIL") {
                res.write(`data: ${JSON.stringify({ fail: true })}\n\n`);
                clearInterval(interval);
                return res.end();
            }

            res.write(`data: ${JSON.stringify({ pending: true })}\n\n`);
        } catch (err) {
            res.write(`data: ${JSON.stringify({ pending: true })}\n\n`);
        }
    }, 5000);

    req.on("close", () => {
        clearInterval(interval);
    });
});

app.post("/nets/complete-fail", (req, res) => {
    try {
        if (req.session) {
            req.session.netsPending = null;
            req.session.netsCapture = null;
        }
        return res.json({ ok: true });
    } catch (err) {
        console.error("nets/complete-fail error:", err);
        return res.status(500).json({ error: "Failed to finalize NETS fail" });
    }
});

app.post("/nets/complete", async (req, res) => {
    try {
        const pending = req.session ? req.session.netsPending : null;
        if (!pending) {
            return res.status(400).json({ error: "No pending NETS payment" });
        }

        const items = Array.isArray(pending.items) && pending.items.length
            ? pending.items
            : getSelectedCartItemsFromSession(req.session).map((i) => ({
                name: i.name,
                price: Number(i.price || 0),
                qty: Number(i.quantity || i.qty || 0),
            }));

        const subtotal = Number.isFinite(Number(pending.subtotal))
            ? Number(pending.subtotal)
            : items.reduce((s, it) => s + Number(it.price || 0) * Number(it.qty || 0), 0);

        const deliveryFee = Number.isFinite(Number(pending.deliveryFee))
            ? Number(pending.deliveryFee)
            : 0;

        const redeemAmount = Number.isFinite(Number(pending.redeemAmount))
            ? Number(pending.redeemAmount)
            : 0;

        const total = Number.isFinite(Number(pending.total))
            ? Number(pending.total)
            : Number((subtotal + deliveryFee - redeemAmount).toFixed(2));

        const orderDbId = await OrdersModel.create({
            userId: req.session.user ? req.session.user.id : null,
            payerEmail: req.session.user?.email || null,
            shippingName: pending.prefs?.name || req.session.user?.username || null,
            items,
            subtotal,
            deliveryFee,
            total,
            status: "paid"
        });

        // Deduct redeemed points first
        if (req.session.user && pending.redeemPoints) {
            try {
                const { balance, entry } = await UsersModel.addPoints(
                    req.session.user.id,
                    -Number(pending.redeemPoints),
                    `Redeem order ${orderDbId} (NETS)`
                );
                req.session.user.points = balance;
                req.session.user.pointsHistory = [entry, ...(req.session.user.pointsHistory || [])].slice(0, 20);
            } catch (err) {
                console.error("Points redeem deduct failed (NETS):", err);
            }
        }

        // Award loyalty points
        if (req.session.user && total > 0) {
            try {
                const earned = Math.floor(total);
                const { balance, entry } = await UsersModel.addPoints(
                    req.session.user.id,
                    earned,
                    `Order ${orderDbId} (NETS)`
                );
                req.session.user.points = balance;
                req.session.user.pointsHistory = [entry, ...(req.session.user.pointsHistory || [])].slice(0, 20);
            } catch (err) {
                console.error("Points award failed (NETS):", err);
            }
        }

        if (req.session) {
            req.session.netsCapture = {
                total: Number(total) || 0,
                txnRetrievalRef: pending.txnRetrievalRef || null,
                txnId: pending.txnRef || null,
                status: "COMPLETED",
                capturedAt: Date.now(),
            };
            req.session.latestOrderDbId = orderDbId;
            req.session.cartRedeem = null;
            req.session.netsPending = null;
        }

        return res.json({ ok: true });
    } catch (err) {
        console.error("nets/complete error:", err);
        return res.status(500).json({ error: "Failed to finalize NETS payment" });
    }
});

  /**
   * GET /debug/session
   * Dev helper: return limited session contents for debugging.
   */
app.get('/debug/session', (req, res) => {
    try {
        const sess = req.session || {};
        const out = {
            paypalPending: sess.paypalPending || null,
            paypalCapture: sess.paypalCapture || null,
            latestOrderDbId: sess.latestOrderDbId || null,
            user: sess.user ? { id: sess.user.id, username: sess.user.username || sess.user.name } : null,
        };
        return res.json({ ok: true, session: out });
    } catch (err) {
        console.error('debug/session error', err);
        return res.status(500).json({ ok: false, error: 'debug failed' });
    }
});




app.post('/stripe/create-checkout-session', async (req, res) => {
  try {
    const cart = getSelectedCartItemsFromSession(req.session);
    if (!cart.length) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    const items = cart.map((i) => ({
      name: i.name,
      price: Number(i.price || 0),
      qty: Number(i.quantity || i.qty || 0)
    }));

    const subtotal = items.reduce((s, it) => s + (it.price * it.qty), 0);
    const deliveryFee = Number(req.body.deliveryFee || 0);
    const { redeemAmount: redeem, redeemPoints } = getRedeemForSubtotalFromSession(req.session, subtotal);
    const total = Number((subtotal + deliveryFee - redeem).toFixed(2));

    req.session.stripePending = {
      items,
      subtotal,
      deliveryFee,
      total,
      redeem,
      redeemPoints,
      prefs: req.session.cartPrefs || null,
      createdAt: Date.now()
    };

    const session = await stripeService.createCheckoutSession({
      // Use total as a single line item to avoid discount math issues
      subtotal: total,
      deliveryFee: 0,
      successUrl: 'http://localhost:3000/stripe/success?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'http://localhost:3000/checkout'
    });

    res.json({ id: session.id });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: 'Stripe session failed' });
  }
});

app.get('/stripe/success', async (req, res) => {
  try {
    const sessionId = req.query.session_id;
    if (!sessionId) return res.redirect('/checkout');

    const session = await stripeService.retrieveCheckoutSession(sessionId);
    if (!session || session.payment_status !== 'paid') {
      return res.redirect('/checkout');
    }

    const pending = req.session.stripePending || {};
    const items = pending.items || [];
    const subtotal = Number(pending.subtotal || 0);
    const deliveryFee = Number(pending.deliveryFee || 0);
    const total = Number(pending.total || session.amount_total / 100 || 0);

    const orderDbId = await OrdersModel.create({
      userId: req.session.user ? req.session.user.id : null,
      payerEmail: session.customer_details?.email || req.session.user?.email || null,
      shippingName: pending.prefs?.name || req.session.user?.username || null,
      items,
      subtotal,
      deliveryFee,
      total,
      status: "paid"
    });

    // Deduct redeemed points first
    if (req.session.user && pending.redeemPoints) {
      try {
        const { balance, entry } = await UsersModel.addPoints(
          req.session.user.id,
          -Number(pending.redeemPoints),
          `Redeem order ${orderDbId} (Stripe)`
        );
        req.session.user.points = balance;
        req.session.user.pointsHistory = [entry, ...(req.session.user.pointsHistory || [])].slice(0, 20);
      } catch (err) {
        console.error("Points redeem deduct failed (Stripe):", err);
      }
    }

    // Award loyalty points
    if (req.session.user && total > 0) {
      try {
        const earned = Math.floor(total);
        const { balance, entry } = await UsersModel.addPoints(
          req.session.user.id,
          earned,
          `Order ${orderDbId} (Stripe)`
        );
        req.session.user.points = balance;
        req.session.user.pointsHistory = [entry, ...(req.session.user.pointsHistory || [])].slice(0, 20);
      } catch (err) {
        console.error("Points award failed (Stripe):", err);
      }
    }

    req.session.stripeCapture = {
      sessionId,
      paymentIntentId: session.payment_intent?.id || null,
      payerEmail: session.customer_details?.email || null,
      total,
      status: session.payment_status
    };

    req.session.latestOrderDbId = orderDbId;
    req.session.cartRedeem = null;
    req.session.stripePending = null;

    return res.redirect('/receipt');
  } catch (err) {
    console.error('Stripe success error:', err);
    return res.redirect('/checkout');
  }
});


/* -------------------- BUSINESS OWNER ROUTES -------------------- */
const ownerRoutes = require("./Routes/bizownerRoutes");
app.use("/bizowner", ownerRoutes);

// Debug routes were removed per request

/* -------------------- DIGITAL WALLET -------------------- */

// GET /digitalwallet
app.get('/digitalwallet', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const redirect = req.query.redirect || '/checkout';
  const requestedTopupRaw = Number(req.query.topup);
  const requestedTopup = Number.isFinite(requestedTopupRaw) && requestedTopupRaw > 0
    ? Number(requestedTopupRaw.toFixed(2))
    : 0;
  await ensureWalletColumn();
  await ensureWalletTransactionsTable();
  const [rows] = await db.query(
    "SELECT wallet_balance FROM users WHERE id=?",
    [req.session.user.id]
  );

  const balance = rows?.[0]?.wallet_balance ?? 0;
  const wallet2fa = req.session.wallet2fa || {};
  const wallet2faVerified = !!wallet2fa.verified && (!wallet2fa.verifiedAt || (Date.now() - wallet2fa.verifiedAt) < 5 * 60 * 1000);

  const dailyLimit = 1000;
  let dailySpent = 0;
  try {
    const [sumRows] = await db.query(
      "SELECT COALESCE(SUM(amount),0) AS total FROM wallet_transactions WHERE user_id=? AND type='payment' AND DATE(created_at)=CURDATE()",
      [req.session.user.id]
    );
    dailySpent = Number(sumRows?.[0]?.total || 0);
  } catch (err) {
    console.error("wallet daily spent error:", err);
  }

  let dailyTopup = 0;
  try {
    dailyTopup = await getDailyTopupTotal(req.session.user.id);
  } catch (err) {
    console.error("wallet daily topup error:", err);
  }

  let transactions = [];
  try {
    const [txRows] = await db.query(
      "SELECT id, type, method, amount, balance_after, created_at FROM wallet_transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 10",
      [req.session.user.id]
    );
    transactions = txRows || [];
  } catch (err) {
    console.error("wallet transactions load error:", err);
  }

  const topupError = req.session.walletTopupError || '';
  req.session.walletTopupError = null;

  res.render('digitalwallet', {
    balance,
    redirect,
    wallet2faVerified,
    transactions,
    dailyLimit,
    dailySpent,
    dailyTopup,
    topupError,
    requestedTopup
  });
});

// POST /wallet/2fa/send
app.post('/wallet/2fa/send', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ ok: false, error: 'Not logged in' });

  const code = generateTwoFactorCode();
  req.session.wallet2fa = {
    code,
    expiresAt: Date.now() + 5 * 60 * 1000,
    verified: false,
    verifiedAt: null
  };

  try {
    await sendEmail({
      to: req.session.user?.email,
      subject: "Your HomeBitez Wallet 2FA code",
      text: `Your HomeBitez wallet verification code is ${code}. It expires in 5 minutes.`
    });
  } catch (err) {
    console.error("Wallet 2FA email send failed:", err);
    return res.status(500).json({ ok: false, error: 'Failed to send 2FA email. Please try again.' });
  }

  return res.json({
    ok: true,
    maskedPhone: maskPhone(req.session.user.contact),
    maskedEmail: maskEmail(req.session.user.email)
  });
});

// POST /wallet/2fa/verify
app.post('/wallet/2fa/verify', (req, res) => {
  if (!req.session.user) return res.status(401).json({ ok: false, error: 'Not logged in' });

  const submitted = String(req.body.code || '').replace(/\s/g, '');
  const w = req.session.wallet2fa || {};

  if (!w.code) return res.status(400).json({ ok: false, error: 'Code not found. Please resend.' });
  if (w.expiresAt && Date.now() > w.expiresAt) return res.status(400).json({ ok: false, error: 'Code expired. Please resend.' });
  if (submitted !== String(w.code)) return res.status(400).json({ ok: false, error: 'Invalid code.' });

  req.session.wallet2fa = { verified: true, verifiedAt: Date.now() };
  return res.json({ ok: true });
});

// POST /digitalwallet/use
app.post('/digitalwallet/use', async (req, res) => {
  if (!req.session.user) return res.json({ success: false, error: 'Not logged in' });

  const total = parseFloat(req.body.total);
  if (isNaN(total) || total <= 0) return res.json({ success: false, error: 'Invalid total' });

  await ensureWalletColumn();
  await ensureWalletTransactionsTable();

  const dailyLimit = 1000;
  let dailySpent = 0;
  try {
    const [sumRows] = await db.query(
      "SELECT COALESCE(SUM(amount),0) AS total FROM wallet_transactions WHERE user_id=? AND type='payment' AND DATE(created_at)=CURDATE()",
      [req.session.user.id]
    );
    dailySpent = Number(sumRows?.[0]?.total || 0);
  } catch (err) {
    console.error("wallet daily spent error:", err);
  }

  if (dailySpent + total > dailyLimit) {
    return res.json({
      success: false,
      error: 'Daily wallet spend limit reached',
      dailyLimit,
      dailySpent
    });
  }

  const [rows] = await db.query(
    "SELECT wallet_balance FROM users WHERE id=?",
    [req.session.user.id]
  );

  const balance = rows?.[0]?.wallet_balance ?? 0;

  if (balance >= total) {
    await db.query(
      "UPDATE users SET wallet_balance = wallet_balance - ? WHERE id=?",
      [total, req.session.user.id]
    );
    const newBalance = Number(balance) - Number(total);
    await recordWalletTxn(req.session.user.id, 'payment', 'wallet', Number(total), newBalance);
    return res.json({ success: true, newBalance });
  }

  const needed = (total - balance).toFixed(2);
  return res.json({ success: false, error: 'Insufficient balance', needed });
});

// POST /digitalwallet/topup
app.post('/digitalwallet/topup', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false });
  if (!wallet2faIsValid(req)) return res.status(403).json({ success: false, error: '2FA required' });

  const amount = parseFloat(req.body.amount);
  if (isNaN(amount) || amount <= 0) return res.status(400).json({ success: false, error: 'Invalid amount' });

  await ensureWalletColumn();
  await ensureWalletTransactionsTable();

  const limitCheck = await checkDailyTopupLimit(req.session.user.id, amount);
  if (!limitCheck.ok) {
    return res.status(400).json({
      success: false,
      error: 'Daily top up limit reached',
      dailyTopup: limitCheck.dailyTopup,
      limit: limitCheck.limit
    });
  }

  await db.query(
    "UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=?",
    [amount, req.session.user.id]
  );

  const [rows] = await db.query(
    "SELECT wallet_balance FROM users WHERE id=?",
    [req.session.user.id]
  );
  const balanceAfter = rows?.[0]?.wallet_balance ?? Number(amount);
  await recordWalletTxn(req.session.user.id, 'topup', 'manual', Number(amount), balanceAfter);
  clearWallet2fa(req);

  // After top-up, redirect back to the original page
  res.json({ success: true, redirect: req.body.redirect || '/checkout' });
});

function wallet2faIsValid(req) {
  const w = req.session.wallet2fa || {};
  if (!w.verified) return false;
  if (w.verifiedAt && (Date.now() - w.verifiedAt) > 5 * 60 * 1000) return false;
  return true;
}

function clearWallet2fa(req) {
  req.session.wallet2fa = { verified: false, verifiedAt: null };
}

// POST /wallet/topup/stripe-session
app.post('/wallet/topup/stripe-session', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ ok: false, error: 'Not logged in' });
  if (!wallet2faIsValid(req)) return res.status(403).json({ ok: false, error: '2FA required' });

  const amount = parseFloat(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: 'Invalid amount' });

  const limitCheck = await checkDailyTopupLimit(req.session.user.id, amount);
  if (!limitCheck.ok) {
    return res.status(400).json({
      ok: false,
      error: 'Daily top up limit reached',
      dailyTopup: limitCheck.dailyTopup,
      limit: limitCheck.limit
    });
  }

  try {
    const session = await stripeService.createWalletTopupSession({
      amount,
      successUrl: 'http://localhost:3000/wallet/stripe/success?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'http://localhost:3000/digitalwallet',
      paymentMethodTypes: ['card', 'grabpay', 'alipay', 'paynow', 'wechat_pay']
    });
    return res.json({ ok: true, id: session.id });
  } catch (err) {
    console.error('Stripe topup session error:', err);
    return res.status(500).json({ ok: false, error: 'Stripe session failed' });
  }
});

// POST /wallet/topup/paynow-session
app.post('/wallet/topup/paynow-session', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ ok: false, error: 'Not logged in' });
  if (!wallet2faIsValid(req)) return res.status(403).json({ ok: false, error: '2FA required' });

  const amount = parseFloat(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: 'Invalid amount' });

  const limitCheck = await checkDailyTopupLimit(req.session.user.id, amount);
  if (!limitCheck.ok) {
    return res.status(400).json({
      ok: false,
      error: 'Daily top up limit reached',
      dailyTopup: limitCheck.dailyTopup,
      limit: limitCheck.limit
    });
  }

  try {
    const session = await stripeService.createWalletTopupSession({
      amount,
      successUrl: 'http://localhost:3000/wallet/stripe/success?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'http://localhost:3000/digitalwallet',
      paymentMethodTypes: ['paynow']
    });
    return res.json({ ok: true, id: session.id });
  } catch (err) {
    console.error('PayNow topup session error:', err);
    return res.status(500).json({ ok: false, error: 'PayNow session failed' });
  }
});

// GET /wallet/stripe/success
app.get('/wallet/stripe/success', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const sessionId = req.query.session_id;
  if (!sessionId) return res.redirect('/digitalwallet');

  try {
    const session = await stripeService.retrieveCheckoutSession(sessionId);
    if (!session || session.payment_status !== 'paid') {
      return res.redirect('/digitalwallet');
    }

    const amount = Number(session.amount_total || 0) / 100;
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.redirect('/digitalwallet');
    }

    const limitCheck = await checkDailyTopupLimit(req.session.user.id, amount);
    if (!limitCheck.ok) {
      req.session.walletTopupError = 'Daily top up limit reached. Try again tomorrow.';
      return res.redirect('/digitalwallet');
    }

    await ensureWalletColumn();
    await db.query(
      "UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=?",
      [amount, req.session.user.id]
    );

    const [rows] = await db.query(
      "SELECT wallet_balance FROM users WHERE id=?",
      [req.session.user.id]
    );
    const balanceAfter = rows?.[0]?.wallet_balance ?? Number(amount);
    await recordWalletTxn(req.session.user.id, 'topup', 'stripe', Number(amount), balanceAfter);
    clearWallet2fa(req);

    return res.redirect('/digitalwallet');
  } catch (err) {
    console.error('Wallet topup success error:', err);
    return res.redirect('/digitalwallet');
  }
});

app.get('/wallet/paypal', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  if (!wallet2faIsValid(req)) {
    req.session.walletTopupError = '2FA required for top up.';
    return res.redirect('/digitalwallet');
  }

  const amount = req.query.amount;
  const parsedAmount = Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    req.session.walletTopupError = 'Invalid top up amount.';
    return res.redirect('/digitalwallet');
  }

  const limitCheck = await checkDailyTopupLimit(req.session.user.id, parsedAmount);
  if (!limitCheck.ok) {
    req.session.walletTopupError = 'Daily top up limit reached. Try again tomorrow.';
    return res.redirect('/digitalwallet');
  }

  const request = new paypal.orders.OrdersCreateRequest();
  request.prefer("return=representation");
  request.requestBody({
    intent: "CAPTURE",
    purchase_units: [{
      amount: {
        currency_code: "SGD",
        value: amount
      }
    }],
    application_context: {
      return_url: `http://localhost:3000/wallet/paypal/success?amount=${amount}`,
      cancel_url: "http://localhost:3000/digitalwallet"
    }
  });

  const order = await paypalClient.execute(request);

  const approveLink = order.result.links.find(link => link.rel === "approve").href;
  res.redirect(approveLink);
});

app.get('/wallet/paypal/success', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const { token, amount } = req.query;
  const parsedAmount = Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    req.session.walletTopupError = 'Invalid top up amount.';
    return res.redirect('/digitalwallet');
  }

  const limitCheck = await checkDailyTopupLimit(req.session.user.id, parsedAmount);
  if (!limitCheck.ok) {
    req.session.walletTopupError = 'Daily top up limit reached. Try again tomorrow.';
    return res.redirect('/digitalwallet');
  }

  // Capture the payment
  const request = new paypal.orders.OrdersCaptureRequest(token);
  request.requestBody({});

  await paypalClient.execute(request);

  // ✅ Now safe to update wallet
  await ensureWalletColumn();
  await db.query(
    "UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=?",
    [parsedAmount, req.session.user.id]
  );

  const [rows] = await db.query(
    "SELECT wallet_balance FROM users WHERE id=?",
    [req.session.user.id]
  );
  const balanceAfter = rows?.[0]?.wallet_balance ?? Number(parsedAmount);
  await recordWalletTxn(req.session.user.id, 'topup', 'paypal', Number(parsedAmount), balanceAfter);
  clearWallet2fa(req);

  // Redirect back to wallet
  res.redirect('/digitalwallet');
});

// GET /wallet/nets/qr
app.get('/wallet/nets/qr', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  if (!wallet2faIsValid(req)) {
    req.session.walletTopupError = '2FA required for top up.';
    return res.redirect('/digitalwallet');
  }

  const parsedAmount = Number(req.query.amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    req.session.walletTopupError = 'Invalid top up amount.';
    return res.redirect('/digitalwallet');
  }

  const limitCheck = await checkDailyTopupLimit(req.session.user.id, parsedAmount);
  if (!limitCheck.ok) {
    req.session.walletTopupError = 'Daily top up limit reached. Try again tomorrow.';
    return res.redirect('/digitalwallet');
  }

  try {
    const qrData = await nets.requestNetsQr(parsedAmount, NETS_TXN_ID);
    if (!nets.isQrSuccess(qrData)) {
      req.session.walletTopupError = qrData?.error_message || 'NETS QR failed.';
      return res.redirect('/digitalwallet');
    }

    const txnRetrievalRef =
      qrData?.txn_retrieval_ref || qrData?.txnRetrievalRef || qrData?.txn_ref || null;
    req.session.walletNetsPending = {
      amount: parsedAmount,
      txnRetrievalRef,
      txnRef: qrData?.txn_ref || null,
      createdAt: Date.now()
    };

    return res.render("netsQr", {
      qrCodeUrl: `data:image/png;base64,${qrData.qr_code}`,
      txnRetrievalRef,
      total: parsedAmount,
      successRedirect: "/digitalwallet",
      completeUrl: "/wallet/nets/complete",
      failCompleteUrl: "/wallet/nets/complete-fail",
      failRedirect: "/digitalwallet",
      backPrimaryUrl: "/digitalwallet",
      backPrimaryLabel: "Back to wallet",
      backSecondaryUrl: "/menu",
      backSecondaryLabel: "Back to menu"
    });
  } catch (err) {
    console.error("Wallet NETS QR error:", err);
    req.session.walletTopupError = 'NETS server error.';
    return res.redirect('/digitalwallet');
  }
});

// POST /wallet/nets/complete
app.post('/wallet/nets/complete', async (req, res) => {
  try {
    if (!req.session.user) return res.status(401).json({ ok: false, error: 'Not logged in' });
    const pending = req.session.walletNetsPending;
    if (!pending) return res.status(400).json({ ok: false, error: 'No pending NETS top up' });

    const amount = Number(pending.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ ok: false, error: 'Invalid top up amount' });
    }

    const limitCheck = await checkDailyTopupLimit(req.session.user.id, amount);
    if (!limitCheck.ok) {
      req.session.walletTopupError = 'Daily top up limit reached. Try again tomorrow.';
      req.session.walletNetsPending = null;
      return res.status(400).json({ ok: false, error: 'Daily top up limit reached' });
    }

    await ensureWalletColumn();
    await db.query(
      "UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=?",
      [amount, req.session.user.id]
    );

    const [rows] = await db.query(
      "SELECT wallet_balance FROM users WHERE id=?",
      [req.session.user.id]
    );
    const balanceAfter = rows?.[0]?.wallet_balance ?? Number(amount);
    await recordWalletTxn(req.session.user.id, 'topup', 'nets', Number(amount), balanceAfter);
    clearWallet2fa(req);
    req.session.walletNetsPending = null;

    return res.json({ ok: true });
  } catch (err) {
    console.error("wallet/nets/complete error:", err);
    return res.status(500).json({ ok: false, error: 'Failed to finalize NETS top up' });
  }
});

// POST /wallet/nets/complete-fail
app.post('/wallet/nets/complete-fail', (req, res) => {
  try {
    if (req.session) {
      req.session.walletNetsPending = null;
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error("wallet/nets/complete-fail error:", err);
    return res.status(500).json({ ok: false, error: 'Failed to finalize NETS fail' });
  }
});



// Example checkout page
app.get('/checkout', (req, res) => {
  if (!req.user) {
    return res.redirect('/login');
  }

  const total = 25.00; // replace with actual cart total
  res.render('checkout', { user: req.user, total });
});

// Start server
app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});





/* -------------------- SERVER -------------------- */
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

