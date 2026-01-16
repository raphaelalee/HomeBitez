const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');
require("dotenv").config();

// Controllers
const UsersController = require('./Controllers/usersController');
const ReportModel = require('./models/ReportModel');

// DB
const db = require('./db');

// NETS service (for QR)
const nets = require("./services/nets");

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

// Make user available in views
app.use((req, res, next) => {
    res.locals.currentUser = req.session.user || null;
    next();
});

app.use(flash());

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

// Home
app.get('/', (req, res) => {
    res.render('index');
});

// Report Issue page
app.get('/report', (req, res) => {
    if (!req.session.user) {
        req.flash('error', 'Please log in to submit a report.');
        return res.redirect('/login');
    }

    res.render('report', {
        success: req.flash('success'),
        error: req.flash('error'),
        userEmail: req.session.user.email || ''
    });
});

app.post('/report', async (req, res) => {
    if (!req.session.user) {
        req.flash('error', 'Please log in to submit a report.');
        return res.redirect('/login');
    }

    const { name, subject, description } = req.body;
    const email = req.session.user.email || '';

    if (!name || !email || !subject || !description) {
        req.flash('error', 'Please fill out all fields.');
        return res.redirect('/report');
    }

    try {
        await ReportModel.create({
            userId: req.session.user.id || null,
            name,
            email,
            subject,
            description
        });

        req.flash('success', 'Report submitted successfully.');
        res.redirect('/report');
    } catch (err) {
        console.error(err);
        req.flash('error', 'Failed to submit report.');
        res.redirect('/report');
    }
});

// Auth
app.get('/login', UsersController.showLogin);
app.post('/login', UsersController.login);
app.get('/register', UsersController.showRegister);
app.post('/register', UsersController.register);
app.post('/signup', UsersController.register);

// Menu (requires login)
app.get('/menu', (req, res) => {
    if (!req.session.user) {
        req.flash('error', 'Please login first.');
        return res.redirect('/login');
    }
    res.render('menu');
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
        const [p] = await db.query("SELECT COUNT(*) AS total FROM products");
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
        adminName: 'Admin'
    });
});

// Logout
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

/* -------------------- CART ROUTES -------------------- */
const cartRoutes = require("./Routes/cartRoutes");
app.use("/cart", cartRoutes);

/* -------------------- CHECKOUT ROUTES -------------------- */
const checkoutRoutes = require("./Routes/checkoutRoutes");
app.use(checkoutRoutes);

/* -------------------- NETS (NO ROUTE FILE, DIRECT HERE) -------------------- */
/**
 * POST /nets/create
 * Called by checkout.ejs when user clicks "Pay with NETS"
 * Creates NETS QR and stores pending reference in session.
 */
app.post("/nets/create", async (req, res) => {
    try {
        const total = parseFloat(req.body.total);

        if (!Number.isFinite(total) || total <= 0) {
            return res.status(400).json({ error: "Invalid amount" });
        }

        const txnRef = `HBZ-${Date.now()}`;

        // You need your nets.js to return something like:
        // { qrCodeUrl, txnRetrievalRef }
        const response = await nets.createNetsPayment(total, txnRef);

        // Store pending so /nets-qr can render it
        req.session.netsPending = {
            txnRef,
            amount: total,
            qrCodeUrl: response.qrCodeUrl || response.qrCode || null,
            txnRetrievalRef: response.txnRetrievalRef || response.txnRef || txnRef,
            createdAt: Date.now()
        };

        return res.json({
            txnRef,
            txnRetrievalRef: req.session.netsPending.txnRetrievalRef
        });
    } catch (err) {
        console.error("NETS create error:", err);
        return res.status(500).json({ error: "NETS payment failed" });
    }
});

/**
 * GET /nets-qr
 * Renders your netsQR.ejs
 * expects query ?txnRef=...
 */
app.get("/nets-qr", (req, res) => {
    const txnRef = req.query.txnRef;
    const pending = req.session.netsPending;

    if (!pending || !txnRef || pending.txnRef !== txnRef) {
        return res.redirect("/checkout");
    }

    // Your netsQR.ejs expects:
    // qrCodeUrl, txnRetrievalRef, amount, timeRemaining (optional)
    res.render("netsQR", {
        qrCodeUrl: pending.qrCodeUrl || "",
        txnRetrievalRef: pending.txnRetrievalRef || pending.txnRef,
        amount: pending.amount,
        timeRemaining: "5:00"
    });
});

/**
 * GET /nets-qr/success
 */
app.get("/nets-qr/success", (req, res) => {
    res.send("NETS payment success (replace with your success page)");
});

/**
 * GET /nets-qr/fail
 */
app.get("/nets-qr/fail", (req, res) => {
    res.send("NETS payment failed (replace with your fail page)");
});

/**
 * SSE: /sse/payment-status/:txnRetrievalRef
 * netsQR.ejs listens here every few seconds.
 * For sandbox you can keep it simple and return SUCCESS after a short time,
 * or call nets service to check actual status if you implemented it.
 */
app.get("/sse/payment-status/:txnRetrievalRef", async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const txnRetrievalRef = req.params.txnRetrievalRef;

    const interval = setInterval(async () => {
        try {
            // If you have real check function:
            // const status = await nets.checkStatus(txnRetrievalRef);

            // Sandbox placeholder:
            const status = "PENDING";

            if (status === "SUCCESS") {
                res.write(`data: ${JSON.stringify({ success: true })}\n\n`);
                clearInterval(interval);
                return res.end();
            }

            if (status === "FAIL") {
                res.write(`data: ${JSON.stringify({ fail: true, message: "Payment failed" })}\n\n`);
                clearInterval(interval);
                return res.end();
            }

            // still pending -> keep connection alive
            res.write(`data: ${JSON.stringify({ pending: true })}\n\n`);
        } catch (e) {
            res.write(`data: ${JSON.stringify({ pending: true })}\n\n`);
        }
    }, 5000);

    req.on("close", () => {
        clearInterval(interval);
    });
});

/* -------------------- BUSINESS OWNER ROUTES -------------------- */
const ownerRoutes = require("./Routes/bizownerRoutes");
app.use("/bizowner", ownerRoutes);

/* -------------------- DIGITAL WALLET -------------------- */
app.get('/digitalwallet', (req, res) => {
    if (!req.session.user) {
        req.flash('error', 'Please login to view your digital wallet.');
        return res.redirect('/login');
    }

    const balance = 120.50;
    const transactions = [
        { date: '2026-01-10', description: 'Top-up', amount: 50, type: 'Credit' },
        { date: '2026-01-12', description: 'Purchase: Chicken Curry', amount: 8.60, type: 'Debit' }
    ];

    res.render('digitalwallet', { balance, transactions });
});

/* -------------------- SERVER -------------------- */
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
