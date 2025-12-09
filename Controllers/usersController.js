const User = require('../models/UsersModel');

module.exports = {

    showLogin(req, res) {
        res.render('login', {
            error: req.flash('error')
        });
    },

    async login(req, res) {
        const { email, password } = req.body;

        const user = await User.findByEmail(email);

        if (!user || user.password !== password) {
            req.flash('error', 'Invalid email or password');
            return res.redirect('/login');
        }

        // Save user session
        req.session.user = {
            id: user.id,
            email: user.email
        };

        return res.redirect('/menu');
    },

    showRegister(req, res) {
        res.render('register', {
            error: req.flash('error')
        });
    },

    async register(req, res) {
        const { email, password } = req.body;

        const existingUser = await User.findByEmail(email);

        if (existingUser) {
            req.flash('error', 'Email is already registered');
            return res.redirect('/register');
        }

        await User.create({ email, password });

        req.flash('success', 'Account created! You may log in now.');
        return res.redirect('/login');
    }
};
