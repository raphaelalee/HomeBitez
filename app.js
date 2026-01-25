const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');
const bcrypt = require('bcryptjs');
require("dotenv").config();

// Controllers
const UsersController = require('./Controllers/usersController');
const ReportModel = require('./models/ReportModel');
const ProductModel = require('./Models/ProductModel');

// DB
const db = require('./db');

// NETS service (for QR)
const nets = require("./services/nets");

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
    reportColumnsEnsured = true;
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

// Make user available in views
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
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
app.get('/report', (req, res) => {
    if (!req.session.user) {
        req.flash('error', 'Please log in to submit a report.');
        return res.redirect('/login');
    }

    const userId = req.session.user.id;
    const userEmail = req.session.user.email || '';

    ensureReportReplyColumns().then(() => {
        return db.query(
            "SELECT id, subject, description, status, created_at, admin_reply, replied_at, user_reply, user_reply_at FROM report_messages WHERE user_id = ? ORDER BY created_at DESC",
            [userId]
        );
    }).then(([rows]) => {
        res.render('report', {
            success: req.flash('success'),
            error: req.flash('error'),
            userEmail,
            issues: rows || []
        });
    }).catch(err => {
        console.error("Report list error:", err);
        res.render('report', {
            success: req.flash('success'),
            error: req.flash('error'),
            userEmail,
            issues: []
        });
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

// Menu (requires login) - load products from DB and pass to view
app.get('/menu', async (req, res) => {
    try {
        const [rows] = await ProductModel.getAll();
        const products = rows || [];

        res.render('menu', {
            user: req.session.user || null,
            products
        });
    } catch (err) {
        console.error('Menu load error:', err);
        res.render('menu', { user: req.session.user || null, products: [] });
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
        adminName: req.session.user?.username || 'Admin'
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
    let totalCost = 0;
    let totalProfit = 0;
    let averageOrderValue = 0;
    let bestItem = { name: "No data", revenue: 0 };
    let chartLabels = [];
    let chartValues = [];
    let growthPercent = 0;

    try {
        const now = new Date();
        for (let i = 5; i >= 0; i -= 1) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            chartLabels.push(d.toLocaleString("en-US", { month: "short" }));
            chartValues.push(0);
        }
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        const startOfPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

        const [summaryRows] = await db.query(
            "SELECT COUNT(*) AS totalOrders, COALESCE(SUM(totalAmount), 0) AS totalRevenue FROM orders WHERE created_at >= ? AND created_at < ?",
            [startOfMonth, startOfNextMonth]
        );
        totalOrders = summaryRows?.[0]?.totalOrders || 0;
        totalRevenue = Number(summaryRows?.[0]?.totalRevenue || 0);
        totalCost = 0;
        totalProfit = totalRevenue - totalCost;
        averageOrderValue = totalOrders ? totalRevenue / totalOrders : 0;

        const [prevRows] = await db.query(
            "SELECT COALESCE(SUM(totalAmount), 0) AS totalRevenue FROM orders WHERE created_at >= ? AND created_at < ?",
            [startOfPrevMonth, startOfMonth]
        );
        const prevRevenue = Number(prevRows?.[0]?.totalRevenue || 0);
        growthPercent = prevRevenue ? ((totalRevenue - prevRevenue) / prevRevenue) * 100 : 0;

        const [bestRows] = await db.query(
            `SELECT p.product_name AS name,
                    SUM(oi.quantity) AS totalSold,
                    SUM(oi.quantity * oi.price) AS revenue
             FROM order_items oi
             JOIN product p ON p.id = oi.productId
             GROUP BY oi.productId
             ORDER BY totalSold DESC
             LIMIT 1`
        );
        if (bestRows && bestRows[0]) {
            bestItem = { name: bestRows[0].name, revenue: Number(bestRows[0].revenue || 0) };
        }

        const startSixMonths = new Date(now.getFullYear(), now.getMonth() - 5, 1);
        const [chartRows] = await db.query(
            `SELECT DATE_FORMAT(created_at, '%Y-%m') AS ym, COALESCE(SUM(totalAmount), 0) AS total
             FROM orders
             WHERE created_at >= ? AND created_at < ?
             GROUP BY ym
             ORDER BY ym ASC`,
            [startSixMonths, startOfNextMonth]
        );

        const totalsByMonth = new Map();
        (chartRows || []).forEach(row => totalsByMonth.set(row.ym, Number(row.total || 0)));

        chartLabels = [];
        chartValues = [];
        for (let i = 5; i >= 0; i -= 1) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            chartLabels.push(d.toLocaleString("en-US", { month: "short" }));
            chartValues.push(totalsByMonth.get(ym) || 0);
        }
    } catch (err) {
        console.error("Admin reports error:", err);
    }

    const monthLabel = new Date().toLocaleString("en-US", { month: "long" });

    res.render('admin-reports', {
        adminName: req.session.user?.username || 'Admin',
        monthLabel,
        totalRevenue,
        totalCost,
        totalProfit,
        totalOrders,
        averageOrderValue,
        bestItem,
        chartLabels,
        chartValues,
        growthPercent
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
                    rm.admin_reply, rm.replied_at, rm.user_reply, rm.user_reply_at, u.contact
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
        adminName: req.session.user?.username || 'Admin'
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

  // Optional: fetch extra data like points history from DB
  const orders = []; // replace with real orders if you have

  res.render('userprofile', { 
      user, 
      orders,
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
        await db.query(
            'INSERT INTO messages (senderId, message, isRead, created_at) VALUES (?, ?, 0, NOW())',
            [req.session.user.id, message]
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

    // register active SSE connection so external notify can push immediately
    try { activeSseConnections[txnRetrievalRef] = res; } catch (e) {}

    const interval = setInterval(async () => {
        try {
            let status = netsStatusOverrides[txnRetrievalRef] || "PENDING";

            // Prefer real NETS enquiry if available
            if (status === "PENDING" && typeof nets.checkStatus === "function") {
                try {
                    const res = await nets.checkStatus(txnRetrievalRef);
                    status = res?.status || status;
                } catch (err) {
                    console.error("NETS status check error:", err.message);
                }
            }

            if (status === "SUCCESS") {
                console.log('SSE: reporting SUCCESS for', txnRetrievalRef);
                res.write(`data: ${JSON.stringify({ success: true })}\n\n`);
                clearInterval(interval);
                return res.end();
            }

            if (status === "FAIL") {
                console.log('SSE: reporting FAIL for', txnRetrievalRef);
                res.write(`data: ${JSON.stringify({ fail: true, message: "Payment failed" })}\n\n`);
                clearInterval(interval);
                return res.end();
            }

            // still pending -> keep connection alive
            // console.log('SSE: pending for', txnRetrievalRef);
            res.write(`data: ${JSON.stringify({ pending: true })}\n\n`);
        } catch (e) {
            res.write(`data: ${JSON.stringify({ pending: true })}\n\n`);
        }
    }, 5000);

    req.on("close", () => {
        clearInterval(interval);
        try { delete activeSseConnections[txnRetrievalRef]; } catch (e) {}
    });
});

// In-memory overrides for testing without simulator app
const netsStatusOverrides = {};
// Active SSE response objects keyed by txnRetrievalRef so external notify can push immediately
const activeSseConnections = {};

/**
 * POST /nets/simulate-success/:txnRetrievalRef
 * Dev helper: mark a txnRetrievalRef as SUCCESS so SSE will report success.
 */
app.post('/nets/simulate-success/:txnRetrievalRef', (req, res) => {
    try {
        const ref = req.params.txnRetrievalRef;
        if (!ref) return res.status(400).json({ error: 'Missing ref' });
        netsStatusOverrides[ref] = 'SUCCESS';
        console.log('Simulated NETS success for', ref);
        return res.json({ ok: true, ref });
    } catch (err) {
        console.error('simulate-success error:', err);
        return res.status(500).json({ error: 'simulate failed' });
    }
});

/**
 * POST /nets/simulate-fail/:txnRetrievalRef
 * Dev helper: mark a txnRetrievalRef as FAIL so SSE will report failure.
 */
app.post('/nets/simulate-fail/:txnRetrievalRef', (req, res) => {
    try {
        const ref = req.params.txnRetrievalRef;
        if (!ref) return res.status(400).json({ error: 'Missing ref' });
        netsStatusOverrides[ref] = 'FAIL';
        console.log('Simulated NETS fail for', ref);
        return res.json({ ok: true, ref });
    } catch (err) {
        console.error('simulate-fail error:', err);
        return res.status(500).json({ error: 'simulate failed' });
    }
});

/**
 * POST /nets/notify/:txnRetrievalRef
 * External webhook (simulator app) can call this to notify server of success.
 */
app.post('/nets/notify/:txnRetrievalRef', (req, res) => {
    try {
        const ref = req.params.txnRetrievalRef;
        if (!ref) return res.status(400).json({ error: 'Missing ref' });

        // set override so polling will return success
        netsStatusOverrides[ref] = 'SUCCESS';

        // if an SSE connection exists, push immediately
        const s = activeSseConnections[ref];
        if (s && !s.writableEnded) {
            console.log('notify: pushing SUCCESS to active SSE for', ref);
            try {
                s.write(`data: ${JSON.stringify({ success: true })}\n\n`);
                s.end();
            } catch (e) { console.error('notify push error', e); }
            try { delete activeSseConnections[ref]; } catch(e){}
        }

        console.log('External notify set SUCCESS for', ref);
        return res.json({ ok: true, ref });
    } catch (err) {
        console.error('nets/notify error:', err);
        return res.status(500).json({ error: 'notify failed' });
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
            netsPending: sess.netsPending || null,
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

/**
 * POST /nets/complete-fail
 * Called by client when NETS reports FAIL to clear pending session data.
 */
app.post('/nets/complete-fail', (req, res) => {
    try {
        if (req.session) req.session.netsPending = null;
        return res.json({ ok: true });
    } catch (err) {
        console.error('nets/complete-fail error:', err);
        return res.status(500).json({ error: 'Failed to finalize NETS fail' });
    }
});

/**
 * POST /nets/complete
 * Called by client when NETS reports SUCCESS so we can set session data
 * that the existing /receipt page expects (paypalPending/paypalCapture).
 */
app.post('/nets/complete', async (req, res) => {
    try {
        const pending = req.session ? req.session.netsPending : null;
        if (!pending) {
            console.log('nets/complete called but no pending in session');
            return res.status(400).json({ error: 'No pending NETS payment' });
        }

        // Map NETS pending into the paypalPending/paypalCapture shape used by receipt
        if (req.session) {
            req.session.paypalPending = {
                total: Number(pending.amount) || 0,
                shippingName: null,
                createdAt: Date.now(),
            };

            req.session.paypalCapture = {
                orderId: pending.txnRef || null,
                status: 'COMPLETED',
                captureId: pending.txnRetrievalRef || null,
                payerEmail: null,
                payerId: null,
                capturedAt: Date.now(),
            };
        }

        console.log('Finalizing NETS payment in session, pending=', pending);
        // Optionally clear netsPending so it won't be reused
        if (req.session) req.session.netsPending = null;

        return res.json({ ok: true });
    } catch (err) {
        console.error('nets/complete error:', err);
        return res.status(500).json({ error: 'Failed to finalize NETS payment' });
    }
});

/* -------------------- BUSINESS OWNER ROUTES -------------------- */
const ownerRoutes = require("./Routes/bizownerRoutes");
app.use("/bizowner", ownerRoutes);

// Debug routes were removed per request

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
