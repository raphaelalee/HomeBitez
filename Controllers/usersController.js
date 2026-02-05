const User = require('../models/UsersModel');
const CartModel = require('../Models/cartModels');
const crypto = require('crypto');
const bcrypt = require('bcryptjs'); // make sure bcryptjs is installed
const { sendEmail } = require('../services/email');

function generateTwoFactorCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}


const LOGIN_LOCK_THRESHOLD = 5;
const LOGIN_LOCK_MS = 5 * 60 * 1000;
const loginAttempts = new Map();

function getLoginKey(req, identifier) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const id = (identifier || 'unknown').toLowerCase();
  return `${id}|${ip}`;
}

function getAttemptState(key) {
  const state = loginAttempts.get(key);
  if (!state) return { count: 0, lockUntil: null };
  if (state.lockUntil && Date.now() >= state.lockUntil) {
    loginAttempts.delete(key);
    return { count: 0, lockUntil: null };
  }
  return state;
}

function recordFailure(key) {
  const state = getAttemptState(key);
  const nextCount = (state.count || 0) + 1;
  if (nextCount >= LOGIN_LOCK_THRESHOLD) {
    const lockUntil = Date.now() + LOGIN_LOCK_MS;
    loginAttempts.set(key, { count: nextCount, lockUntil });
    return { locked: true, lockUntil };
  }
  loginAttempts.set(key, { count: nextCount, lockUntil: null });
  return { locked: false };
}

function clearFailures(key) {
  loginAttempts.delete(key);
}

// Helper: check plaintext or legacy hashes (MD5/SHA1)
function passwordMatches(user, providedPassword) {
  if (!user) return false;

  const candidateFields = ['password', 'Password', 'password_hash', 'pass', 'pwd', 'user_password', 'user_pass'];
  const passwordToCheck = providedPassword == null ? '' : String(providedPassword);

  const md5 = crypto.createHash('md5').update(passwordToCheck).digest('hex');
  const sha1 = crypto.createHash('sha1').update(passwordToCheck).digest('hex');

  for (const field of candidateFields) {
    if (user[field] === undefined || user[field] === null) continue;
    const stored = String(user[field]);

    // bcrypt hash detection
    if (/^\$2[aby]\$\d{2}\$/.test(stored)) {
      try {
        if (bcrypt.compareSync(passwordToCheck, stored)) return true;
      } catch (err) {
        console.error('Password hash compare failed', err);
      }
    }

    // MD5 / SHA1 legacy hash support
    if (stored.toLowerCase() === md5 || stored.toLowerCase() === sha1) return true;

    // Plaintext compare
    if (stored === passwordToCheck) return true;
  }

  return false;
}

module.exports = {

  showLogin(req, res) {
    res.render('login', { error: req.flash('error') });
  },

  async login(req, res) {
    const identifier = (req.body.email || '').trim();
    const providedPassword = (req.body.password || '').trim();
    const key = getLoginKey(req, identifier);
    const attemptState = getAttemptState(key);

    if (attemptState.lockUntil) {
      const remainingMs = attemptState.lockUntil - Date.now();
      const remainingMin = Math.max(1, Math.ceil(remainingMs / 60000));
      req.flash('error', `Too many failed attempts. Try again in ${remainingMin} minute(s).`);
      return res.redirect('/login');
    }

    const user = await User.findByEmailOrUsername(identifier);
    if (!user) {
      const r = recordFailure(key);
      req.flash('error', r.locked ? 'Too many failed attempts. Locked for 5 minutes.' : 'Invalid email or password');
      return res.redirect('/login');
    }

    let match = false;

    // 1️⃣ Try bcrypt if password is hashed
    if (user.password && /^\$2[aby]\$\d{2}\$/.test(user.password)) {
      match = await bcrypt.compare(providedPassword, user.password);
    }

    // 2️⃣ Fallback to plaintext / MD5 / SHA1
    if (!match && passwordMatches(user, providedPassword)) {
      match = true;
      // Auto-upgrade legacy password to bcrypt
      const hashed = await bcrypt.hash(providedPassword, 10);
      await User.updatePassword(user.id, hashed);
    }

    if (!match) {
      const r = recordFailure(key);
      req.flash('error', r.locked ? 'Too many failed attempts. Locked for 5 minutes.' : 'Invalid email or password');
      return res.redirect('/login');
    }
    clearFailures(key);

    // make sure points column exists and fetch points
    await User.ensurePointsColumn();
    const userPoints = Number(user.points || 0);

    // Save user session
    req.session.user = {
      id: user.id || user.user_id,
      email: user.email,
      username: user.username,
      role: user.role,
      avatar: user.avatar || '/images/default-avatar.png',
      address: user.address || '',
      contact: user.contact || '',
      points: userPoints,
      twoFactorVerified: false
    };

    // Issue email-only 2FA
    const emailCode = generateTwoFactorCode();
    req.session.twoFactor = {
      stage: 'email',
      email: { code: emailCode, expiresAt: Date.now() + 5 * 60 * 1000 },
      emailVerified: false
    };

    if (user.role === 'biz_owner') req.session.post2faRedirect = '/bizowner';
    else if (user.role === 'admin') req.session.post2faRedirect = '/admin';
    else req.session.post2faRedirect = '/menu';

    try {
      await sendEmail({
        to: user.email,
        subject: "Your HomeBitez 2FA code",
        text: `Your HomeBitez verification code is ${emailCode}. It expires in 5 minutes.`
      });
    } catch (err) {
      console.error("2FA email send failed:", err);
      req.flash('error', 'Failed to send 2FA email. Please try again.');
      return res.redirect('/login');
    }

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

    // Redirect to 2FA verification (email)
    return res.redirect('/2fa/email');
  },

  showRegister(req, res) {
    res.render('register', { error: req.flash('error') });
  },

  async register(req, res) {
    try {
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

      // Hash password before saving
      const hashedPassword = await bcrypt.hash(password, 10);

      await User.create({ username, email, contact, password: hashedPassword, role: 'user' });

      req.flash('success', 'Account created! You may log in now.');
      return res.redirect('/login');
    } catch (err) {
      console.error('Register error:', err);
      req.flash('error', 'Registration failed. Please try again.');
      return res.redirect('/register');
    }
  },

  // Change password
  async changePassword(req, res) {
    if (!req.session.user) {
      req.flash('error', 'Please log in first.');
      return res.redirect('/login');
    }

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
      const rows = await User.findById(userId);
      if (!rows || rows.length === 0) {
        req.flash('error', 'User not found.');
        return res.redirect('/user/profile');
      }

      const user = rows[0];
      const dbPassword = user.password;

      let match = false;

      // bcrypt check
      if (dbPassword && /^\$2[aby]\$\d{2}\$/.test(dbPassword)) {
        match = await bcrypt.compare(currentPassword, dbPassword);
      }

      // fallback legacy check
      if (!match && passwordMatches(user, currentPassword)) {
        match = true;
      }

      if (!match) {
        req.flash('error', 'Current password is incorrect.');
        return res.redirect('/user/profile');
      }

      // Hash new password and update
      const hashedNew = await bcrypt.hash(newPassword, 10);
      await User.updatePassword(userId, hashedNew);

      req.flash('success', 'Password updated successfully!');
      res.redirect('/user/profile');
    } catch (err) {
      console.error('Change password error:', err);
      req.flash('error', 'Error updating password.');
      res.redirect('/user/profile');
    }
  }
};


