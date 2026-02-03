const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
require("dotenv").config();
const stripeService = require('./services/stripe');

// Controllers
const UsersController = require('./Controllers/usersController');
const ReportModel = require('./models/ReportModel');
const ProductModel = require('./Models/ProductModel');
const OrdersModel = require('./Models/OrdersModel');
const UsersModel = require('./Models/UsersModel');

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
    reportColumnsEnsured = true;
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
    if (!phone) return '-';
    const digits = String(phone).replace(/\D/g, '');
    if (digits.length <= 3) return '***' + digits;
    return '*'.repeat(Math.max(0, digits.length - 3)) + digits.slice(-3);
}

function issueTwoFactor(req, stage) {
    const code = generateTwoFactorCode();
    if (!req.session.twoFactor) {
        req.session.twoFactor = {
            stage: stage || 'phone',
            phone: { code: null, expiresAt: null },
            email: { code: null, expiresAt: null },
            phoneVerified: false,
            emailVerified: false
        };
    }

    const expiresAt = Date.now() + 5 * 60 * 1000;
    if (stage === 'email') {
        req.session.twoFactor.email = { code, expiresAt };
        req.session.twoFactor.stage = 'email';
    } else {
        req.session.twoFactor.phone = { code, expiresAt };
        req.session.twoFactor.stage = 'phone';
    }

    req.flash('success', `Demo code: ${code}`);
    console.log('2FA ' + stage + ' code for', req.session.user?.email || req.session.user?.username, ':', code);
    return code;
}


// Public routes allowed without login
const publicPaths = [
    '/',
    '/menu',
    '/contact',
    '/report',
    '/login',
    '/register',
    '/signup',
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
    if (!tf.phoneVerified) return res.redirect('/2fa/phone');
    if (!tf.emailVerified) return res.redirect('/2fa/email');
    return res.redirect('/2fa/phone');
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
app.get('/report', (req, res) => {
    if (!req.session.user) {
        req.flash('error', 'Please log in to submit a report.');
        return res.redirect('/login');
    }

    const userId = req.session.user.id;
    const userEmail = req.session.user.email || '';

    ensureReportReplyColumns().then(() => {
        return db.query(
            "SELECT id, subject, description, status, created_at, admin_reply, replied_at, user_reply, user_reply_at, order_id, address, image_url FROM report_messages WHERE user_id = ? ORDER BY created_at DESC",
            [userId]
        );
    }).then(([rows]) => {
        res.render('report', {
            success: req.flash('success'),
            error: req.flash('error'),
            userEmail,
            userAddress: req.session.user?.address || req.session.cartPrefs?.address || '',
            orderId: req.session.lastReceiptOrderId || '',
            issues: rows || []
        });
    }).catch(err => {
        console.error("Report list error:", err);
        res.render('report', {
            success: req.flash('success'),
            error: req.flash('error'),
            userEmail,
            userAddress: req.session.user?.address || req.session.cartPrefs?.address || '',
            orderId: req.session.lastReceiptOrderId || '',
            issues: []
        });
    });
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
        const imageUrl = req.file ? `/images/${req.file.filename}` : null;
        await ReportModel.create({
            userId: req.session.user.id || null,
            name,
            email,
            subject,
            description,
            orderId: cleanOrderId,
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


// 2FA verification (phone first, then email)
app.get('/2fa/phone', (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    const tf = req.session.twoFactor || {};
    const phone = tf.phone || {};
    if (!phone.code || (phone.expiresAt && Date.now() > phone.expiresAt)) {
        issueTwoFactor(req, 'phone');
    }

    res.render('2fa-phone', {
        error: req.flash('error'),
        success: req.flash('success'),
        maskedPhone: maskPhone(req.session.user.contact),
        maskedEmail: maskEmail(req.session.user.email)
    });
});

app.post('/2fa/phone/verify', (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    const submitted = String(req.body.code || '').replace(/\s/g, '');
    const tf = req.session.twoFactor || {};
    const phone = tf.phone || {};

    if (!phone.code) {
        req.flash('error', 'Verification code not found. Please resend.');
        return res.redirect('/2fa/phone');
    }

    if (phone.expiresAt && Date.now() > phone.expiresAt) {
        req.flash('error', 'Code expired. Please resend.');
        return res.redirect('/2fa/phone');
    }

    if (submitted != String(phone.code)) {
        req.flash('error', 'Invalid code. Please try again.');
        return res.redirect('/2fa/phone');
    }

    req.session.twoFactor.phoneVerified = true;
    issueTwoFactor(req, 'email');
    return res.redirect('/2fa/email');
});

app.post('/2fa/phone/resend', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    issueTwoFactor(req, 'phone');
    return res.redirect('/2fa/phone');
});

app.get('/2fa/email', (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    const tf = req.session.twoFactor || {};
    if (!tf.phoneVerified) return res.redirect('/2fa/phone');

    const email = tf.email || {};
    if (!email.code || (email.expiresAt && Date.now() > email.expiresAt)) {
        issueTwoFactor(req, 'email');
    }

    res.render('2fa-email', {
        error: req.flash('error'),
        success: req.flash('success'),
        maskedPhone: maskPhone(req.session.user.contact),
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

app.post('/2fa/email/resend', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    issueTwoFactor(req, 'email');
    return res.redirect('/2fa/email');
});

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

            // Award points for NETS payment (1 point per $1)
            if (req.session.user && pending.amount) {
                try {
                    const UsersModel = require("./Models/UsersModel");
                    // Deduct redeemed points first if any
                    if (req.session.cartRedeem?.points) {
                        const { balance, entry } = await UsersModel.addPoints(req.session.user.id, -Number(req.session.cartRedeem.points), `Redeem NETS ${pending.txnRetrievalRef || ''}`.trim());
                        req.session.user.points = balance;
                        req.session.user.pointsHistory = [entry, ...(req.session.user.pointsHistory || [])].slice(0,20);
                    }

                    const earned = Math.floor(Number(pending.amount)); // 1 pt = $1
                    const { balance, entry } = await UsersModel.addPoints(req.session.user.id, earned, `NETS ${pending.txnRetrievalRef || ''}`.trim());
                    req.session.user.points = balance;
                    req.session.user.pointsHistory = [entry, ...(req.session.user.pointsHistory || [])].slice(0,20);
                    req.session.cartRedeem = null;
                } catch (err) {
                    console.error("Points award failed (NETS):", err);
                }
            }
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



app.post('/stripe/create-checkout-session', async (req, res) => {
  try {
    const cart = req.session.cart || [];
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
    const redeem = Math.min(subtotal, Number(req.session.cartRedeem?.amount || 0));
    const redeemPoints = Number(req.session.cartRedeem?.points || 0);
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
  const [rows] = await db.promise().query(
    "SELECT wallet_balance FROM users WHERE id=?",
    [req.session.user.id]
  );

  const balance = rows[0].wallet_balance;

  res.render('digitalwallet', { balance, redirect });
});

// POST /digitalwallet/use
app.post('/digitalwallet/use', async (req, res) => {
  if (!req.session.user) return res.json({ success: false, error: 'Not logged in' });

  const total = parseFloat(req.body.total);
  if (isNaN(total) || total <= 0) return res.json({ success: false, error: 'Invalid total' });

  const [rows] = await db.promise().query(
    "SELECT wallet_balance FROM users WHERE id=?",
    [req.session.user.id]
  );

  const balance = rows[0].wallet_balance;

  if (balance >= total) {
    await db.promise().query(
      "UPDATE users SET wallet_balance = wallet_balance - ? WHERE id=?",
      [total, req.session.user.id]
    );
    return res.json({ success: true, newBalance: balance - total });
  }

  const needed = (total - balance).toFixed(2);
  return res.json({ success: false, error: 'Insufficient balance', needed });
});

// POST /digitalwallet/topup
app.post('/digitalwallet/topup', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false });

  const amount = parseFloat(req.body.amount);
  if (isNaN(amount) || amount <= 0) return res.status(400).json({ success: false, error: 'Invalid amount' });

  await db.promise().query(
    "UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=?",
    [amount, req.session.user.id]
  );

  // After top-up, redirect back to the original page
  res.json({ success: true, redirect: req.body.redirect || '/checkout' });
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

