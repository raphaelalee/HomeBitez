const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');

// Controllers
const UsersController = require('./Controllers/usersController');

// DB
const db = require('./db');

// Initialize app FIRST (important)
const app = express();

/* -------------------- MIDDLEWARE -------------------- */
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Serve static files (correct position)
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'supersecretkey123',
    resave: false,
    saveUninitialized: false
}));

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

// Export upload so other routes can use it
module.exports.upload = upload;

/* -------------------- ROUTES -------------------- */

// Home
app.get('/', (req, res) => {
    res.render('index');
});

// Auth routes
app.get('/login', UsersController.showLogin);
app.post('/login', UsersController.login);
app.get('/register', UsersController.showRegister);
app.post('/register', UsersController.register);

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
app.use("/owner", ownerRoutes);

/* -------------------- SERVER -------------------- */
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
