const User = require('../models/UsersModel');
const crypto = require('crypto');

// Optional bcrypt (in case dependency isn't installed yet)
let bcrypt;
try {
  bcrypt = require('bcryptjs');
} catch (err) {
  console.warn('bcryptjs not installed; bcrypt hashes will not be verified. Run `npm install` to enable.');
}

// Helper: check plaintext or bcrypt-hashed passwords, including numeric legacy values
function passwordMatches(user, providedPassword) {
  if (!user) return false;

  const candidateFields = [
    'password',
    'Password',
    'password_hash',
    'pass',
    'pwd',
    'user_password',
    'user_pass'
  ];

  const passwordToCheck = providedPassword == null ? '' : String(providedPassword);

  const md5 = crypto.createHash('md5').update(passwordToCheck).digest('hex');
  const sha1 = crypto.createHash('sha1').update(passwordToCheck).digest('hex');

  for (const field of candidateFields) {
    if (user[field] === undefined || user[field] === null) continue;
    const stored = String(user[field]);

    // bcrypt hash detection and compare
    if (/^\$2[aby]\$\d{2}\$/.test(stored)) {
      if (!bcrypt) continue;
      try {
        if (bcrypt.compareSync(passwordToCheck, stored)) return true;
      } catch (err) {
        console.error('Password hash compare failed', err);
      }
    }

    // MD5 / SHA1 legacy hash support
    if (stored.toLowerCase() === md5 || stored.toLowerCase() === sha1) {
      return true;
    }

    // Plaintext compare
    if (stored === passwordToCheck) return true;
  }

  return false;
}

module.exports = {
  showLogin(req, res) {
    res.render('login', {
      error: req.flash('error')
    });
  },

  async login(req, res) {
    const identifier = (req.body.email || '').trim();
    const providedPassword = (req.body.password || '').trim();

    const user = await User.findByEmailOrUsername(identifier);

    if (!user || !passwordMatches(user, providedPassword)) {
      req.flash('error', 'Invalid email or password');
      return res.redirect('/login');
    }

    // Save user session (include role)
    req.session.user = {
      id: user.id || user.user_id,
      email: user.email,
      username: user.username,
      role: user.role,
      avatar: user.avatar || '/images/default-avatar.png', // add this line
      address: user.address || '', // optional
      contact: user.contact || ''  // optional
    };

    // Role-based redirect
    if (user.role === 'biz_owner') return res.redirect('/bizowner');
    if (user.role === 'admin') return res.redirect('/admin'); 
    return res.redirect('/menu');
  },

  showRegister(req, res) {
    res.render('register', {
      error: req.flash('error')
    });
  },

  async register(req, res) {
    const { username, email, contact, password, confirmPassword } = req.body;

    if (!username || !email || !contact || !password || !confirmPassword) {
      req.flash('error', 'Please fill in all required fields.');
      return res.redirect('/register');
    }

    if (password !== confirmPassword) {
      req.flash('error', 'Passwords do not match.');
      return res.redirect('/register');
    }

    const existingUser = await User.findByEmail(email);

    if (existingUser) {
      req.flash('error', 'Email is already registered');
      return res.redirect('/register');
    }

    await User.create({ username, email, contact, password, role: 'user' });

    req.flash('success', 'Account created! You may log in now.');
    return res.redirect('/login');
  }
};
