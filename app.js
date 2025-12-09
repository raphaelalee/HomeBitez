const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');
const UsersController = require('./Controllers/usersController');
const db = require('./db');

const app = express();

/* -------------------- MIDDLEWARE -------------------- */
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'supersecretkey123',
    resave: false,
    saveUninitialized: false
}));

app.use(flash());

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

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

// Menu page after login
app.get('/menu', (req, res) => {
    // require login
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


/* -------------------- SERVER -------------------- */
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
