const express = require('express');
const session = require('express-session');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const SEED_FILE = path.join(__dirname, 'seed-users.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ADMIN = { username: 'fatema', password: 'moronali21' };
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const norm = (s) => String(s ?? '').trim();

function readSeedUsers() {
  try {
    if (!fs.existsSync(SEED_FILE)) return [];
    const raw = fs.readFileSync(SEED_FILE, 'utf8').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.users) ? parsed.users : [];
    return list
      .map((u) => ({
        username: norm(u.username),
        password: norm(u.password),
        role: u.role === 'admin' ? 'admin' : 'member',
        kicked: !!u.kicked,
      }))
      .filter((u) => u.username && u.password);
  } catch {
    return [];
  }
}

function seedData() {
  const seeded = readSeedUsers();
  const users = seeded.length
    ? seeded.map((u) => ({
        username: u.username,
        passwordHash: sha256(u.password),
        role: u.role,
        kicked: u.kicked,
        createdAt: new Date().toISOString(),
      }))
    : [
        {
          username: ADMIN.username,
          passwordHash: sha256(ADMIN.password),
          role: 'admin',
          kicked: false,
          createdAt: new Date().toISOString(),
        },
      ];

  if (!users.some((u) => u.role === 'admin')) {
    users.unshift({
      username: ADMIN.username,
      passwordHash: sha256(ADMIN.password),
      role: 'admin',
      kicked: false,
      createdAt: new Date().toISOString(),
    });
  }

  return { users, posts: [], votes: {} };
}

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const seed = seedData();
      fs.writeFileSync(DATA_FILE, JSON.stringify(seed, null, 2));
      return seed;
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf8').trim();
    if (!raw) return seedData();
    const parsed = JSON.parse(raw);
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      posts: Array.isArray(parsed.posts) ? parsed.posts : [],
      votes: parsed.votes && typeof parsed.votes === 'object' ? parsed.votes : {},
    };
  } catch {
    return seedData();
  }
}

let db = loadData();
const saveData = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));

function findUser(username) {
  const target = norm(username).toLowerCase();
  return db.users.find((u) => u.username.toLowerCase() === target);
}

function rankFor(points) {
  const ranks = [
    { name: 'SSR', min: 650, color: '#5a24d6' },
    { name: 'SS', min: 550, color: '#6e32df' },
    { name: 'S', min: 450, color: '#7c42e8' },
    { name: 'A', min: 350, color: '#8a54f1' },
    { name: 'B', min: 250, color: '#9a66ff' },
    { name: 'C', min: 150, color: '#a47bff' },
    { name: 'D', min: 80, color: '#b293ff' },
    { name: 'F', min: 0, color: '#555' },
  ];
  return ranks.find((r) => points >= r.min) || ranks[ranks.length - 1];
}

function enrichPost(post, viewer) {
  const votes = db.votes[post.id] || {};
  const values = Object.values(votes).map(Number).filter((n) => !Number.isNaN(n));
  const totalPoints = values.reduce((a, b) => a + b, 0);
  const voteCount = values.length;
  const myVote = viewer ? votes[viewer.username] : null;
  return {
    ...post,
    totalPoints,
    voteCount,
    average: voteCount ? Number((totalPoints / voteCount).toFixed(2)) : 0,
    myVote: myVote ?? null,
  };
}

function userStats(username) {
  const posts = db.posts.filter((p) => p.owner.toLowerCase() === username.toLowerCase());
  const enriched = posts.map((p) => enrichPost(p));
  enriched.sort((a, b) => b.totalPoints - a.totalPoints || new Date(b.createdAt) - new Date(a.createdAt));
  const top10 = enriched.slice(0, 10);
  const points = top10.reduce((sum, p) => sum + p.totalPoints, 0);
  const rank = rankFor(points);
  return {
    username,
    posts: posts.length,
    top10Points: points,
    rank: rank.name,
    rankColor: rank.color,
    kicked: !!findUser(username)?.kicked,
  };
}

function buildLeaderboard() {
  return db.users
    .map((u) => userStats(u.username))
    .sort((a, b) => b.top10Points - a.top10Points || a.username.localeCompare(b.username));
}

function authRequired(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'login required' });
  const user = findUser(req.session.user.username);
  if (!user) return res.status(401).json({ error: 'invalid session' });
  if (user.kicked) return res.status(403).json({ error: 'kicked' });
  req.user = user;
  next();
}

function adminRequired(req, res, next) {
  authRequired(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    next();
  });
}

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname || '');
    const base = path.basename(file.originalname || 'file', ext).replace(/[^a-z0-9-_]+/gi, '_');
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}-${base}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });
const uploadPost = upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'thumbnailFile', maxCount: 1 },
]);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'editor-rank-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' },
  })
);
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(PUBLIC_DIR));

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.json({ user: null });
  const user = findUser(req.session.user.username);
  if (!user || user.kicked) return res.json({ user: null });
  res.json({ user: { username: user.username, role: user.role, kicked: user.kicked } });
});

app.post('/api/auth/register', (req, res) => {
  const username = norm(req.body.username);
  const password = norm(req.body.password);
  if (!username || !password) return res.status(400).json({ error: 'missing fields' });
  if (findUser(username)) return res.status(400).json({ error: 'username exists' });
  const user = {
    username,
    passwordHash: sha256(password),
    role: 'member',
    kicked: false,
    createdAt: new Date().toISOString(),
  };
  db.users.push(user);
  req.session.user = { username: user.username };
  saveData();
  res.json({ ok: true, user: { username: user.username, role: user.role } });
});

app.post('/api/auth/login', (req, res) => {
  const username = norm(req.body.username);
  const password = norm(req.body.password);
  const user = findUser(username);
  if (!user) return res.status(400).json({ error: 'invalid login' });
  if (user.kicked) return res.status(403).json({ error: 'kicked' });
  if (sha256(password) !== user.passwordHash) return res.status(400).json({ error: 'invalid login' });
  req.session.user = { username: user.username };
  res.json({ ok: true, user: { username: user.username, role: user.role } });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.post('/api/auth/profile', authRequired, (req, res) => {
  if (req.user.role !== 'member') return res.status(403).json({ error: 'members only' });

  const currentPassword = norm(req.body.currentPassword);
  const newUsername = norm(req.body.newUsername);
  const newPassword = norm(req.body.newPassword);
  const wantsUsername = !!newUsername;
  const wantsPassword = !!newPassword;

  if (!currentPassword) return res.status(400).json({ error: 'current password required' });
  if (sha256(currentPassword) !== req.user.passwordHash) return res.status(400).json({ error: 'wrong current password' });
  if (!wantsUsername && !wantsPassword) return res.status(400).json({ error: 'nothing to update' });

  const oldUsername = req.user.username;

  if (wantsUsername) {
    const sameName = req.user.username.toLowerCase() === newUsername.toLowerCase();
    if (!sameName && findUser(newUsername)) return res.status(400).json({ error: 'username exists' });
    if (!sameName) {
      req.user.username = newUsername;
      db.posts.forEach((p) => {
        if (p.owner.toLowerCase() === oldUsername.toLowerCase()) p.owner = newUsername;
      });
      Object.values(db.votes).forEach((voteMap) => {
        if (!voteMap || typeof voteMap !== 'object') return;
        if (voteMap[oldUsername] !== undefined) {
          const oldVote = voteMap[oldUsername];
          delete voteMap[oldUsername];
          voteMap[newUsername] = oldVote;
        }
      });
      req.session.user.username = newUsername;
    }
  }

  if (wantsPassword) req.user.passwordHash = sha256(newPassword);

  saveData();
  res.json({ ok: true, user: { username: req.user.username, role: req.user.role } });
});

app.get('/api/dashboard', authRequired, (req, res) => {
  const posts = db.posts
    .map((p) => enrichPost(p, req.user))
    .sort((a, b) => b.totalPoints - a.totalPoints || new Date(b.createdAt) - new Date(a.createdAt))
    .map((p, i) => ({ ...p, isTop10: i < 10 }));
  const top10Total = posts.slice(0, 10).reduce((sum, p) => sum + p.totalPoints, 0);
  const rank = rankFor(top10Total);
  res.json({
    posts,
    top10Total,
    counted: Math.min(posts.length, 10),
    rank: { name: rank.name, min: rank.min, color: rank.color },
    membersCount: db.users.length,
    leaderboard: buildLeaderboard(),
  });
});

app.post('/api/posts', authRequired, uploadPost, (req, res) => {
  const title = norm(req.body.title);
  if (!title) return res.status(400).json({ error: 'title required' });

  const video = req.files?.video?.[0];
  const thumbnailFile = req.files?.thumbnailFile?.[0];
  const thumbnailUrl = norm(req.body.thumbnailUrl);

  const post = {
    id: uuidv4(),
    title,
    owner: req.user.username,
    createdAt: new Date().toISOString(),
    videoPath: video ? `/uploads/${path.basename(video.path)}` : '',
    thumbnailPath: thumbnailFile ? `/uploads/${path.basename(thumbnailFile.path)}` : '',
    thumbnailUrl,
  };

  db.posts.unshift(post);
  saveData();
  res.json({ ok: true, post: enrichPost(post, req.user) });
});

app.put('/api/posts/:id', authRequired, uploadPost, (req, res) => {
  const post = db.posts.find((p) => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'not found' });
  if (req.user.role !== 'admin' && post.owner.toLowerCase() !== req.user.username.toLowerCase()) return res.status(403).json({ error: 'forbidden' });

  const title = norm(req.body.title);
  if (title) post.title = title;

  const video = req.files?.video?.[0];
  const thumbnailFile = req.files?.thumbnailFile?.[0];
  const thumbnailUrl = norm(req.body.thumbnailUrl);

  if (video) post.videoPath = `/uploads/${path.basename(video.path)}`;
  if (thumbnailFile) post.thumbnailPath = `/uploads/${path.basename(thumbnailFile.path)}`;
  if (thumbnailUrl || thumbnailUrl === '') post.thumbnailUrl = thumbnailUrl;

  saveData();
  res.json({ ok: true, post: enrichPost(post, req.user) });
});

app.delete('/api/posts/:id', authRequired, (req, res) => {
  const idx = db.posts.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const post = db.posts[idx];
  if (req.user.role !== 'admin' && post.owner.toLowerCase() !== req.user.username.toLowerCase()) return res.status(403).json({ error: 'forbidden' });
  db.posts.splice(idx, 1);
  delete db.votes[post.id];
  saveData();
  res.json({ ok: true });
});

app.post('/api/posts/:id/rate', authRequired, (req, res) => {
  if (req.user.role === 'admin') return res.status(403).json({ error: 'admin cannot vote' });
  const value = Number(req.body.rating);
  if (!Number.isInteger(value) || value < 0 || value > 10) return res.status(400).json({ error: 'rating 0-10' });
  const post = db.posts.find((p) => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'not found' });
  if (post.owner.toLowerCase() === req.user.username.toLowerCase()) return res.status(400).json({ error: 'cannot vote own post' });
  if (!db.votes[post.id]) db.votes[post.id] = {};
  if (db.votes[post.id][req.user.username] !== undefined) return res.status(400).json({ error: 'already voted' });
  db.votes[post.id][req.user.username] = value;
  saveData();
  res.json({ ok: true });
});

app.get('/api/members', authRequired, (req, res) => {
  res.json({ membersCount: db.users.length, leaderboard: buildLeaderboard() });
});

app.get('/api/admin/members', adminRequired, (req, res) => {
  const members = db.users.map((u) => {
    const stats = userStats(u.username);
    return {
      username: u.username,
      role: u.role,
      kicked: !!u.kicked,
      createdAt: u.createdAt,
      postCount: stats.posts,
      top10Points: stats.top10Points,
      rank: stats.rank,
    };
  });
  res.json({ members, membersCount: db.users.length });
});

app.post('/api/admin/members/:username/kick', adminRequired, (req, res) => {
  const user = findUser(req.params.username);
  if (!user) return res.status(404).json({ error: 'not found' });
  if (user.role === 'admin') return res.status(400).json({ error: 'cannot kick admin' });
  user.kicked = true;
  saveData();
  res.json({ ok: true });
});

app.post('/api/admin/members/:username/restore', adminRequired, (req, res) => {
  const user = findUser(req.params.username);
  if (!user) return res.status(404).json({ error: 'not found' });
  user.kicked = false;
  saveData();
  res.json({ ok: true });
});

app.delete('/api/admin/members/:username', adminRequired, (req, res) => {
  const username = req.params.username;
  if (username.toLowerCase() === ADMIN.username.toLowerCase()) return res.status(400).json({ error: 'cannot delete admin' });
  db.users = db.users.filter((u) => u.username.toLowerCase() !== username.toLowerCase());
  db.posts = db.posts.filter((p) => p.owner.toLowerCase() !== username.toLowerCase());
  Object.keys(db.votes).forEach((pid) => {
    if (db.votes[pid]) delete db.votes[pid][username];
  });
  saveData();
  res.json({ ok: true });
});

app.get('/api/admin/posts', adminRequired, (req, res) => {
  res.json({ posts: db.posts.map((p) => enrichPost(p, req.user)).sort((a, b) => b.totalPoints - a.totalPoints) });
});

app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
