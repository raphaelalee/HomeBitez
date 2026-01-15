const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');

// Controllers
const UsersController = require('./Controllers/usersController');
const ReportModel = require('./models/ReportModel');

// DB
const db = require('./db');

// Initialize app
const app = express();

/* -------------------- MIDDLEWARE -------------------- */
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'supersecretkey123',
    resave: false,
    saveUninitialized: false
}));

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

// Export upload for other routes
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

app.post('/report', (req, res) => {
    if (!req.session.user) {
        req.flash('error', 'Please log in to submit a report.');
        return res.redirect('/login');
    }

    const { name, subject, description } = req.body;
    const email = req.session.user.email || '';

    if (!name || !email || !subject || !description) {
        req.flash('error', 'Please fill out all fields before submitting.');
        return res.redirect('/report');
    }

    ReportModel.create({
        userId: req.session.user.id || null,
        name,
        email,
        subject,
        description
    }).then(() => {
        req.flash('success', 'Thanks for letting us know. We will review your report shortly.');
        return res.redirect('/report');
    }).catch((err) => {
        console.error('Error saving report:', err);
        req.flash('error', 'Could not save your report right now. Please try again.');
        return res.redirect('/report');
    });
});

// Auth routes
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

// Logout
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

// Cart routes
const cartRoutes = require('./Routes/cartRoutes');
app.use('/cart', cartRoutes);

// Business Owner routes
const ownerRoutes = require("./Routes/bizownerRoutes");
app.use("/bizowner", ownerRoutes);

/* -------------------- DIGITAL WALLET ROUTE -------------------- */
app.get('/digitalwallet', (req, res) => {
    if (!req.session.user) {
        req.flash('error', 'Please login to view your digital wallet.');
        return res.redirect('/login');
    }

    // Dummy data for now
    const balance = 120.50;
    const transactions = [
        { date: '2026-01-10', description: 'Top-up', amount: 50, type: 'Credit' },
        { date: '2026-01-12', description: 'Purchase: Chicken Curry', amount: 8.60, type: 'Debit' },
        { date: '2026-01-14', description: 'Top-up', amount: 100, type: 'Credit' },
        { date: '2026-01-15', description: 'Purchase: Naan', amount: 2.50, type: 'Debit' }
    ];

    res.render('digitalwallet', { balance, transactions });
});

/* -------------------- SERVER -------------------- */
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

