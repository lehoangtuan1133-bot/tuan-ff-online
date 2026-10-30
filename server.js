const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

// --- CẤU HÌNH ---
const JWT_SECRET = process.env.JWT_SECRET || 'bi-mat-game-cua-ban-2024';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
// Mật khẩu mặc định là "admin123" (Hash của nó bên dưới)
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

const rooms = {}; 
const bannedIPs = new Set();

app.use(express.json());
app.use(express.static(__dirname)); // Cho phép truy cập index.html và admin.html

// --- API ĐĂNG NHẬP ---
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (username !== ADMIN_USERNAME) return res.status(401).json({ error: 'Sai tài khoản' });
    const valid = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
    if (!valid) return res.status(401).json({ error: 'Sai mật khẩu' });
    
    const token = jwt.sign({ role: 'admin', username }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, username });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- SOCKET.IO ---
io.use((socket, next) => {
  const ip = socket.handshake.address;
  if (bannedIPs.has(ip)) return next(new Error('BANNED_IP'));
  
  const token = socket.handshake.auth.token;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.isAdmin = decoded.role === 'admin';
    } catch (e) {}
  }
  socket.ip = ip;
  next();
});

io.on('connection', (socket) => {
  console.log('Kết nối:', socket.id, socket.isAdmin ? '(ADMIN)' : '');

  // --- NGƯỜI CHƠI ---
  socket.on('joinRoom', ({ roomId, team, username }) => {
    if (!rooms[roomId]) rooms[roomId] = {};
    rooms[roomId][socket.id] = { team, username, x:0, y:0, z:8, hp: 100, ip: socket.ip };
    socket.join(roomId);
    socket.roomId = roomId;
    io.to(roomId).emit('roomState', rooms[roomId]);
  });

  socket.on('playerUpdate', (data) => {
    if (rooms[socket.roomId] && rooms[socket.roomId][socket.id]) {
      Object.assign(rooms[socket.roomId][socket.id], data);
      socket.to(socket.roomId).emit('playerMoved', { id: socket.id, ...data });
    }
  });

  socket.on('shoot', (data) => socket.to(socket.roomId).emit('playerShot', { id: socket.id, ...data }));
  
  socket.on('switchTeam', ({ team }) => {
    if (rooms[socket.roomId] && rooms[socket.roomId][socket.id]) {
      rooms[socket.roomId][socket.id].team = team;
      io.to(socket.roomId).emit('roomState', rooms[socket.roomId]);
    }
  });

  socket.on('leaveRoom', () => {
    if (rooms[socket.roomId]) {
      delete rooms[socket.roomId][socket.id];
      io.to(socket.roomId).emit('roomState', rooms[socket.roomId]);
    }
  });

  socket.on('startMatch', () => {
    if (rooms[socket.roomId]) io.to(socket.roomId).emit('matchStarted');
  });

  // --- ADMIN ---
  socket.on('admin:getRooms', () => {
    if (!socket.isAdmin) return;
    const list = Object.entries(rooms).map(([id, p]) => ({ id, count: Object.keys(p).length }));
    socket.emit('admin:roomList', list);
  });

  socket.on('admin:getPlayers', (roomId) => {
    if (!socket.isAdmin || !rooms[roomId]) return;
    const list = Object.entries(rooms[roomId]).map(([id, p]) => ({ id, ...p }));
    socket.emit('admin:playerList', { roomId, players: list });
  });

  socket.on('admin:ban', ({ targetId, username, ip }) => {
    if (!socket.isAdmin) return;
    if (ip) bannedIPs.add(ip);
    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) targetSocket.disconnect(true);
    socket.emit('admin:success', `Đã ban ${username}`);
  });

  socket.on('admin:grant', ({ targetId, type, value }) => {
    if (!socket.isAdmin) return;
    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) targetSocket.emit('admin:received', { type, value });
    socket.emit('admin:success', `Đã gửi ${type} cho người chơi`);
  });

  socket.on('disconnect', () => {
    if (rooms[socket.roomId]) {
      delete rooms[socket.roomId][socket.id];
      io.to(socket.roomId).emit('roomState', rooms[socket.roomId]);
    }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server chạy trên cổng ${PORT}`));
