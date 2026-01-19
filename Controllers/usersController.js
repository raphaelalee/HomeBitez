const User = require('../models/UsersModel');
const crypto = require('crypto');
const bcrypt = require('bcryptjs'); // make sure bcryptjs is installed

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

    const user = await User.findByEmailOrUsername(identifier);
    if (!user) {
      req.flash('error', 'Invalid email or password');
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
      req.flash('error', 'Invalid email or password');
      return res.redirect('/login');
    }

    // Save user session
    req.session.user = {
      id: user.id || user.user_id,
      email: user.email,
      username: user.username,
      role: user.role,
      avatar: user.avatar || '/images/default-avatar.png',
      address: user.address || '',
      contact: user.contact || ''
    };

    // Redirect based on role
    if (user.role === 'biz_owner') return res.redirect('/bizowner');
    if (user.role === 'admin') return res.redirect('/admin');
    return res.redirect('/menu');
  },

  showRegister(req, res) {
    res.render('register', { error: req.flash('error') });
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

    // Hash password before saving
    const hashedPassword = await bcrypt.hash(password, 10);

    await User.create({ username, email, contact, password: hashedPassword, role: 'user' });

    req.flash('success', 'Account created! You may log in now.');
    return res.redirect('/login');
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


