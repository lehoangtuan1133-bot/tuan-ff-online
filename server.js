// ============================================================
// BATTLE ROYALE 3D - SERVER (có bảo mật admin)
// ============================================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const server = http.createServer(app);

// CORS cho phép mọi nguồn (vì client có thể chạy ở localhost hoặc file://)
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ============================================================
// CẤU HÌNH BẢO MẬT
// ============================================================
const JWT_SECRET = process.env.JWT_SECRET || 'doi-chuoi-nay-thanh-bi-mat-that-dai-va-kho-doan-2024';
// Hash của mật khẩu admin. Mật khẩu gốc là: admin123
// Muốn đổi: chạy lệnh trong Node:
//   node -e "console.log(require('bcryptjs').hashSync('mat-khau-moi', 10))"
// rồi copy kết quả vào đây.
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

// ============================================================
// DỮ LIỆU TRONG BỘ NHỚ
// ============================================================
const rooms = {};              // { roomId: { players: { socketId: {...} }, format, teamSize, started } }
const bannedUsernames = new Set();
const bannedIPs = new Set();
const admins = new Set();      // socketId của admin đang online

// ============================================================
// MIDDLEWARE EXPRESS
// ============================================================
app.use(express.json());
app.use(express.static(__dirname)); // Cho phép truy cập admin.html, index.html

// ============================================================
// API ĐĂNG NHẬP ADMIN
// ============================================================
app.post('/api/admin/login', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Thiếu mật khẩu' });

    const valid = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
    if (!valid) return res.status(401).json({ error: 'Sai mật khẩu' });

    const token = jwt.sign({ role: 'admin', username: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token });
  } catch (e) {
    res.status(500).json({ error: 'Lỗi server: ' + e.message });
  }
});

// API kiểm tra token còn hạn
app.post('/api/admin/verify', (req, res) => {
  const { token } = req.body;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ valid: true, role: decoded.role });
  } catch {
    res.json({ valid: false });
  }
});

// ============================================================
// SOCKET.IO - MIDDLEWARE XÁC THỰC
// ============================================================
io.use((socket, next) => {
  const ip = socket.handshake.address;
  const username = socket.handshake.auth.username;

  // Chặn IP bị ban
  if (bannedIPs.has(ip)) {
    return next(new Error('BANNED_IP'));
  }
  // Chặn username bị ban
  if (username && bannedUsernames.has(username)) {
    return next(new Error('BANNED_USERNAME'));
  }

  // Nếu có token admin thì gán quyền
  const token = socket.handshake.auth.token;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.user = decoded;
      socket.isAdmin = decoded.role === 'admin';
    } catch (e) {
      // Token sai, vẫn cho kết nối với tư cách guest
    }
  }

  socket.ip = ip;
  next();
});

// ============================================================
// SOCKET.IO - XỬ LÝ SỰ KIỆN
// ============================================================
io.on('connection', (socket) => {
  console.log(`[+] Kết nối: ${socket.id} (IP: ${socket.ip})`);

  if (socket.isAdmin) {
    admins.add(socket.id);
    console.log(`    → ADMIN đã kết nối: ${socket.id}`);
  }

  // ---------- NGƯỜI CHƠI THƯỜNG ----------

  // Vào phòng
  socket.on('joinRoom', ({ roomId, team, format, username }) => {
    if (!roomId || !/^\d{5}$/.test(roomId)) {
      return socket.emit('joinError', 'ID phòng không hợp lệ');
    }
    if (bannedUsernames.has(username) || bannedIPs.has(socket.ip)) {
      return socket.emit('banned', 'Bạn đã bị cấm khỏi server.');
    }

    const teamSize = parseInt(format[0]) || 1;
    if (!rooms[roomId]) {
      rooms[roomId] = { players: {}, format, teamSize, started: false };
    }
    const room = rooms[roomId];
    const maxPlayers = room.teamSize * 2;

    if (Object.keys(room.players).length >= maxPlayers) {
      return socket.emit('joinError', 'Phòng đã đầy');
    }

    // Nếu đội chỉ định đầy, chuyển sang đội kia
    let assignedTeam = team;
    let teamCount = Object.values(room.players).filter(p => p.team === assignedTeam).length;
    if (teamCount >= room.teamSize) {
      assignedTeam = assignedTeam === 'red' ? 'blue' : 'red';
      teamCount = Object.values(room.players).filter(p => p.team === assignedTeam).length;
      if (teamCount >= room.teamSize) {
        return socket.emit('joinError', 'Cả hai đội đều đầy');
      }
    }

    room.players[socket.id] = {
      x: 0, y: 0, z: 8, yaw: 0,
      team: assignedTeam,
      hp: 100,
      username: username || `Player_${socket.id.substr(0, 4)}`,
      ip: socket.ip
    };
    socket.join(roomId);
    socket.roomId = roomId;

    io.to(roomId).emit('roomState', room.players);
    console.log(`[ROOM ${roomId}] ${username} vào đội ${assignedTeam}`);
  });

  // Người chơi gửi vị trí
  socket.on('playerUpdate', (data) => {
    const room = rooms[socket.roomId];
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id] = { ...room.players[socket.id], ...data };
    socket.to(socket.roomId).emit('playerMoved', { id: socket.id, ...data });
  });

  // Người chơi bắn
  socket.on('shoot', (data) => {
    if (!rooms[socket.roomId]) return;
    socket.to(socket.roomId).emit('playerShot', { id: socket.id, ...data });
  });

  // Chuyển đội
  socket.on('switchTeam', ({ team }) => {
    const room = rooms[socket.roomId];
    if (!room || !room.players[socket.id]) return;
    const targetCount = Object.values(room.players).filter(p => p.team === team).length;
    if (targetCount >= room.teamSize && room.players[socket.id].team !== team) {
      return socket.emit('toast', 'Đội kia đã đầy');
    }
    room.players[socket.id].team = team;
    io.to(socket.roomId).emit('roomState', room.players);
  });

  // Yêu cầu cập nhật lại danh sách phòng
  socket.on('requestRoomState', () => {
    const room = rooms[socket.roomId];
    if (room) socket.emit('roomState', room.players);
  });

  // Rời phòng
  socket.on('leaveRoom', () => {
    const room = rooms[socket.roomId];
    if (room) {
      delete room.players[socket.id];
      io.to(socket.roomId).emit('roomState', room.players);
      io.to(socket.roomId).emit('playerLeft', socket.id);
      socket.leave(socket.roomId);
      socket.roomId = null;
    }
  });

  // Bắt đầu trận
  socket.on('startMatch', () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    room.started = true;
    io.to(socket.roomId).emit('matchStarted');
  });

  // ---------- ADMIN ----------

  // Lấy danh sách phòng đang có
  socket.on('admin:getRooms', () => {
    if (!socket.isAdmin) return;
    const roomList = Object.entries(rooms).map(([id, r]) => ({
      id,
      playerCount: Object.keys(r.players).length,
      maxPlayers: r.teamSize * 2,
      format: r.format,
      started: r.started
    }));
    socket.emit('admin:roomList', roomList);
  });

  // Lấy danh sách người chơi trong phòng
  socket.on('admin:getPlayers', (roomId) => {
    if (!socket.isAdmin) return;
    const room = rooms[roomId];
    if (!room) return socket.emit('admin:error', 'Phòng không tồn tại');

    const players = Object.entries(room.players).map(([id, data]) => ({
      id,
      username: data.username,
      ip: data.ip,
      team: data.team,
      hp: data.hp,
      isBanned: bannedUsernames.has(data.username)
    }));
    socket.emit('admin:playerList', { roomId, players });
  });

  // Ban người chơi
  socket.on('admin:ban', ({ roomId, targetId, username, ip, reason }) => {
    if (!socket.isAdmin) return socket.emit('admin:error', 'Không có quyền');
    
    if (username) bannedUsernames.add(username);
    if (ip) bannedIPs.add(ip);
    
    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) {
      targetSocket.emit('banned', reason || 'Bạn đã bị ban bởi admin.');
      targetSocket.disconnect(true);
    }
    socket.emit('admin:success', `Đã ban ${username || targetId}`);
    console.log(`[ADMIN] Ban: ${username} (IP ${ip})`);
  });

  // Gỡ ban
  socket.on('admin:unban', ({ username, ip }) => {
    if (!socket.isAdmin) return;
    if (username) bannedUsernames.delete(username);
    if (ip) bannedIPs.delete(ip);
    socket.emit('admin:success', `Đã gỡ ban ${username || ip}`);
  });

  // Kick (không ban vĩnh viễn)
  socket.on('admin:kick', ({ targetId, reason }) => {
    if (!socket.isAdmin) return socket.emit('admin:error', 'Không có quyền');
    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) {
      targetSocket.emit('kicked', reason || 'Bạn đã bị đuổi khỏi phòng.');
      targetSocket.disconnect(true);
    }
    socket.emit('admin:success', 'Đã kick người chơi');
  });

  // "Cho" người chơi thứ gì đó
  socket.on('admin:grant', ({ targetId, type, value }) => {
    if (!socket.isAdmin) return socket.emit('admin:error', 'Không có quyền');
    const targetSocket = io.sockets.sockets.get(targetId);
    if (!targetSocket) return socket.emit('admin:error', 'Người chơi không online');
    
    targetSocket.emit('admin:received', { type, value });
    
    // Nếu là máu, cập nhật luôn trong room data
    const room = rooms[targetSocket.roomId];
    if (room && room.players[targetId] && type === 'health') {
      room.players[targetId].hp = Math.min(100, room.players[targetId].hp + value);
    }
    socket.emit('admin:success', `Đã gửi ${type}=${value} cho ${targetId.substr(0,6)}`);
  });

  // Xem danh sách ban
  socket.on('admin:getBans', () => {
    if (!socket.isAdmin) return;
    socket.emit('admin:bans', {
      usernames: Array.from(bannedUsernames),
      ips: Array.from(bannedIPs)
    });
  });

  // Đóng phòng
  socket.on('admin:closeRoom', (roomId) => {
    if (!socket.isAdmin) return;
    const room = rooms[roomId];
    if (!room) return;
    io.to(roomId).emit('roomClosed', 'Admin đã đóng phòng này.');
    Object.keys(room.players).forEach(id => {
      const s = io.sockets.sockets.get(id);
      if (s) { s.leave(roomId); s.roomId = null; }
    });
    delete rooms[roomId];
    socket.emit('admin:success', `Đã đóng phòng ${roomId}`);
  });

  // ---------- NGẮT KẾT NỐI ----------
  socket.on('disconnect', () => {
    console.log(`[-] Ngắt kết nối: ${socket.id}`);
    admins.delete(socket.id);

    const room = rooms[socket.roomId];
    if (room) {
      delete room.players[socket.id];
      io.to(socket.roomId).emit('roomState', room.players);
      io.to(socket.roomId).emit('playerLeft', socket.id);
      // Xóa phòng nếu trống
      if (Object.keys(room.players).length === 0) {
        delete rooms[socket.roomId];
        console.log(`[ROOM ${socket.roomId}] Đã xóa (trống)`);
      }
    }
  });
});

// ============================================================
// KHỞI ĐỘNG
// ============================================================
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server chạy tại cổng ${PORT}`);
  console.log(`   Game:  http://localhost:${PORT}/index.html`);
  console.log(`   Admin: http://localhost:${PORT}/admin.html`);
});
