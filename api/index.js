// api/index.js - BACKEND RAYYXPRIMZE STORE
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// ============ DARI ENVIRONMENT VARIABLES (AMAN) ============
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const FIREBASE_SECRET = process.env.FIREBASE_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_OWNER_ID = process.env.TELEGRAM_OWNER_ID || '7966336512';

// Helper functions
async function fetchFromFirebase(path) {
  const url = `${FIREBASE_DB_URL}${path}.json?auth=${FIREBASE_SECRET}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Firebase error: ${response.status}`);
  return response.json();
}

async function writeToFirebase(path, data, method = 'PUT') {
  const url = `${FIREBASE_DB_URL}${path}.json?auth=${FIREBASE_SECRET}`;
  const response = await fetch(url, {
    method: method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!response.ok) throw new Error(`Firebase write error: ${response.status}`);
  return response.json();
}

function generateSessionToken(userId, role) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  return { token, expiresAt };
}

async function authMiddleware(req, res, next) {
  const sessionToken = req.headers['x-session-token'];
  if (!sessionToken) {
    return res.status(401).json({ error: 'Unauthorized: No session token' });
  }
  
  try {
    const sessions = await fetchFromFirebase('/sessions');
    let validSession = null;
    
    for (const [key, session] of Object.entries(sessions || {})) {
      if (session.token === sessionToken && session.expiresAt > Date.now()) {
        validSession = session;
        break;
      }
    }
    
    if (!validSession) {
      return res.status(401).json({ error: 'Unauthorized: Invalid or expired session' });
    }
    
    req.userId = validSession.userId;
    req.userRole = validSession.role;
    next();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ============ API ENDPOINTS ============

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Get products (public)
app.get('/api/products', async (req, res) => {
  try {
    const products = await fetchFromFirebase('/products');
    res.json(products || {});
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// LOGIN
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username dan password wajib diisi' });
  }
  
  try {
    const users = await fetchFromFirebase('/users');
    let foundUser = null;
    let userId = null;
    
    for (const [id, user] of Object.entries(users || {})) {
      if (user.username === username) {
        foundUser = user;
        userId = id;
        break;
      }
    }
    
    if (!foundUser) {
      return res.status(401).json({ error: 'Username tidak ditemukan' });
    }
    
    const hashedInput = crypto.createHash('sha256').update(password).digest('hex');
    if (foundUser.passwordHash !== hashedInput) {
      return res.status(401).json({ error: 'Password salah' });
    }
    
    if (foundUser.isBanned) {
      return res.status(403).json({ error: 'Akun Anda telah diblokir' });
    }
    
    const { token, expiresAt } = generateSessionToken(userId, foundUser.role);
    await writeToFirebase(`/sessions/${userId}_${Date.now()}`, {
      userId,
      role: foundUser.role,
      token,
      expiresAt,
      createdAt: Date.now()
    });
    
    res.json({
      success: true,
      token,
      user: {
        id: userId,
        username: foundUser.username,
        role: foundUser.role,
        koin: foundUser.koin || 0,
        level: foundUser.level || 'ROOKIE'
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// REGISTER
app.post('/api/register', async (req, res) => {
  const { username, password, referralCode } = req.body;
  
  if (!username || username.length < 3) {
    return res.status(400).json({ error: 'Username minimal 3 karakter' });
  }
  if (!password || password.length < 3) {
    return res.status(400).json({ error: 'Password minimal 3 karakter' });
  }
  
  try {
    const users = await fetchFromFirebase('/users');
    
    for (const user of Object.values(users || {})) {
      if (user.username === username) {
        return res.status(400).json({ error: 'Username sudah digunakan' });
      }
    }
    
    const userId = `user_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
    const userReferralCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    
    let bonusKoin = 1000;
    let referredBy = null;
    
    if (referralCode) {
      for (const [id, user] of Object.entries(users || {})) {
        if (user.referralCode === referralCode) {
          referredBy = user.username;
          bonusKoin = 2000;
          await writeToFirebase(`/users/${id}/koin`, (user.koin || 0) + 500, 'PATCH');
          break;
        }
      }
    }
    
    const newUser = {
      username,
      passwordHash: hashedPassword,
      koin: bonusKoin,
      level: 'ROOKIE',
      role: 'member',
      isBanned: false,
      referralCode: userReferralCode,
      referredBy,
      createdAt: Date.now(),
      lastLogin: Date.now()
    };
    
    await writeToFirebase(`/users/${userId}`, newUser);
    
    if (TELEGRAM_BOT_TOKEN) {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_OWNER_ID,
          text: `🆕 *PENDAFTARAN BARU*\n👤 Username: ${username}\n📅 Tanggal: ${new Date().toLocaleString('id-ID')}\n🎁 Bonus Koin: ${bonusKoin}`,
          parse_mode: 'Markdown'
        })
      });
    }
    
    res.json({
      success: true,
      message: 'Pendaftaran berhasil',
      userId,
      bonusKoin
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET PROFILE (perlu login)
app.get('/api/profile', authMiddleware, async (req, res) => {
  try {
    const user = await fetchFromFirebase(`/users/${req.userId}`);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    delete user.passwordHash;
    res.json({ ...user, id: req.userId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// UPDATE ROLE (hanya owner)
app.post('/api/admin/update-role', authMiddleware, async (req, res) => {
  if (req.userRole !== 'owner') {
    return res.status(403).json({ error: 'Forbidden: Only owner can update roles' });
  }
  
  const { targetUserId, newRole } = req.body;
  const allowedRoles = ['member', 'premium', 'reseller', 'admin', 'owner'];
  
  if (!allowedRoles.includes(newRole)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  
  try {
    await writeToFirebase(`/users/${targetUserId}/role`, newRole, 'PATCH');
    res.json({ success: true, message: 'Role updated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET ALL USERS (hanya admin/owner)
app.get('/api/admin/users', authMiddleware, async (req, res) => {
  if (!['admin', 'owner'].includes(req.userRole)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  try {
    const users = await fetchFromFirebase('/users');
    const safeUsers = {};
    for (const [id, user] of Object.entries(users || {})) {
      const { passwordHash, ...safeUser } = user;
      safeUsers[id] = safeUser;
    }
    res.json(safeUsers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// TOGGLE BAN (hanya owner)
app.post('/api/admin/toggle-ban', authMiddleware, async (req, res) => {
  if (req.userRole !== 'owner') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  const { targetUserId, isBanned } = req.body;
  
  try {
    await writeToFirebase(`/users/${targetUserId}/isBanned`, isBanned, 'PATCH');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE USER (hanya owner)
app.delete('/api/admin/delete-user/:userId', authMiddleware, async (req, res) => {
  if (req.userRole !== 'owner') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  try {
    await writeToFirebase(`/users/${req.params.userId}`, null, 'DELETE');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// LOGOUT
app.post('/api/logout', authMiddleware, async (req, res) => {
  try {
    const sessions = await fetchFromFirebase('/sessions');
    for (const [key, session] of Object.entries(sessions || {})) {
      if (session.userId === req.userId) {
        await writeToFirebase(`/sessions/${key}`, null, 'DELETE');
      }
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = app;
