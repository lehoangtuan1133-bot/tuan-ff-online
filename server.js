const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DATABASE_URL = process.env.DATABASE_URL;
const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
}) : null;
const memoryAccounts = new Map();
const rooms = new Map();
const playerRoom = new Map();
const bannedNames = new Set();
const failedAdminLogins = new Map();
let serverLocked = false;
let announcement = '';

const normalizeUsername = value => String(value || '').trim().normalize('NFKC');
const usernameKey = value => normalizeUsername(value).toLocaleLowerCase('en-US');
function validUsername(name) {
  return /^[\p{L}\p{N}_]{3,16}$/u.test(name);
}
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function verifyPassword(password, account) {
  const actual = Buffer.from(hashPassword(password, account.salt), 'hex');
  const expected = Buffer.from(account.passwordHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
async function createAccount(username, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);
  if (pool) {
    try {
      const result = await pool.query(
        'INSERT INTO game_accounts (username, username_key, password_salt, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, username',
        [username, usernameKey(username), salt, passwordHash]
      );
      return { id: String(result.rows[0].id), username: result.rows[0].username };
    } catch (error) {
      if (error.code === '23505') throw new Error('Tên tài khoản đã được sử dụng.');
      throw error;
    }
  }
  const key = usernameKey(username);
  if (memoryAccounts.has(key)) throw new Error('Tên tài khoản đã được sử dụng.');
  const account = { id: crypto.randomUUID(), username, salt, passwordHash };
  memoryAccounts.set(key, account);
  return { id: account.id, username: account.username };
}
async function findAccount(username) {
  if (pool) {
    const result = await pool.query(
      'SELECT id, username, password_salt AS salt, password_hash AS "passwordHash" FROM game_accounts WHERE username_key = $1 LIMIT 1',
      [usernameKey(username)]
    );
    return result.rows[0] || null;
  }
  return memoryAccounts.get(usernameKey(username)) || null;
}

app.get('/health', (_req, res) => res.status(200).json({
  ok: true, service: 'Tuan FF Online', players: playerRoom.size,
  rooms: rooms.size, locked: serverLocked, accountsStorage: pool ? 'postgres' : 'memory',
  uptime: Math.floor(process.uptime())
}));
app.use(express.static(path.join(__dirname)));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

function roomPlayers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return {};
  const result = {};
  for (const [id, player] of room.players) result[id] = player;
  return result;
}
function emitRoomState(roomId) { io.to(roomId).emit('roomState', roomPlayers(roomId)); }
function adminSnapshot() {
  const players = [];
  for (const [id, connected] of io.sockets.sockets) {
    if (!connected.data.userId || !connected.data.username) continue;
    const roomId = playerRoom.get(id) || null;
    const roomPlayer = roomId ? rooms.get(roomId)?.players.get(id) : null;
    players.push({ id, username: connected.data.username, accountId: connected.data.userId,
      team: roomPlayer?.team || '-', roomId: roomId || 'Sảnh' });
  }
  return {
    players,
    rooms: [...rooms].map(([id, r]) => ({ id, count: r.players.size, capacity: r.teamSize * 2, started: r.started, format: r.format })),
    locked: serverLocked, announcement, uptime: Math.floor(process.uptime())
  };
}
function broadcastAdminState() {
  for (const s of io.sockets.sockets.values()) if (s.data.isAdmin) s.emit('admin:state', adminSnapshot());
}
function removeFromRoom(socket) {
  const roomId = playerRoom.get(socket.id);
  if (!roomId) return;
  const room = rooms.get(roomId);
  playerRoom.delete(socket.id);
  socket.leave(roomId);
  if (!room) return;
  room.players.delete(socket.id);
  io.to(roomId).emit('playerLeft', socket.id);
  if (room.players.size === 0) rooms.delete(roomId);
  else emitRoomState(roomId);
  broadcastAdminState();
}
function notifyAdminLogin(socket, ok, message) { socket.emit('admin:authResult', { ok, message }); }

io.on('connection', socket => {
  socket.on('account:register', async ({ username: rawName, password } = {}) => {
    const username = normalizeUsername(rawName);
    if (!validUsername(username)) return socket.emit('account:result', { ok: false, message: 'Tên tài khoản phải dài 3–16 ký tự, chỉ gồm chữ, số hoặc dấu gạch dưới.' });
    if (typeof password !== 'string' || password.length < 6 || password.length > 72) return socket.emit('account:result', { ok: false, message: 'Mật khẩu phải từ 6 đến 72 ký tự.' });
    if (bannedNames.has(usernameKey(username))) return socket.emit('account:result', { ok: false, message: 'Tên tài khoản này đang bị admin cấm.' });
    try {
      const account = await createAccount(username, password);
      socket.data.userId = account.id;
      socket.data.username = account.username;
      socket.emit('account:result', { ok: true, username: account.username, message: 'Tạo tài khoản thành công! Chào mừng bạn.' });
      broadcastAdminState();
    } catch (error) {
      socket.emit('account:result', { ok: false, message: error.message || 'Không thể tạo tài khoản. Thử lại sau.' });
    }
  });

  socket.on('account:login', async ({ username: rawName, password } = {}) => {
    const username = normalizeUsername(rawName);
    if (!username || typeof password !== 'string') return socket.emit('account:result', { ok: false, message: 'Nhập tên tài khoản và mật khẩu.' });
    if (bannedNames.has(usernameKey(username))) return socket.emit('account:result', { ok: false, message: 'Tài khoản này đang bị admin cấm.' });
    try {
      const account = await findAccount(username);
      if (!account || !verifyPassword(password, account)) return socket.emit('account:result', { ok: false, message: 'Tên tài khoản hoặc mật khẩu không đúng.' });
      socket.data.userId = String(account.id);
      socket.data.username = account.username;
      socket.emit('account:result', { ok: true, username: account.username, message: 'Đăng nhập thành công!' });
      broadcastAdminState();
    } catch (error) {
      console.error('Account login error:', error);
      socket.emit('account:result', { ok: false, message: 'Lỗi cơ sở dữ liệu tài khoản. Kiểm tra DATABASE_URL trên Render.' });
    }
  });

  socket.on('admin:login', ({ password } = {}) => {
    const now = Date.now();
    const failed = failedAdminLogins.get(socket.handshake.address) || { count: 0, until: 0 };
    if (failed.until > now) return notifyAdminLogin(socket, false, 'Thử lại sau ít phút.');
    if (!ADMIN_PASSWORD) return notifyAdminLogin(socket, false, 'Admin chưa cấu hình ADMIN_PASSWORD trên Render.');
    if (typeof password !== 'string' || password !== ADMIN_PASSWORD) {
      failed.count++;
      if (failed.count >= 5) { failed.count = 0; failed.until = now + 5 * 60 * 1000; }
      failedAdminLogins.set(socket.handshake.address, failed);
      return notifyAdminLogin(socket, false, 'Sai mật khẩu admin.');
    }
    failedAdminLogins.delete(socket.handshake.address);
    socket.data.isAdmin = true;
    notifyAdminLogin(socket, true, 'Đăng nhập admin thành công.');
    socket.emit('admin:state', adminSnapshot());
  });

  socket.on('admin:refresh', () => {
    if (!socket.data.isAdmin) return socket.emit('admin:error', 'Bạn không có quyền admin.');
    socket.emit('admin:state', adminSnapshot());
  });

  socket.on('admin:logout', () => { socket.data.isAdmin = false; });

  socket.on('admin:action', (action = {}) => {
    if (!socket.data.isAdmin) return socket.emit('admin:error', 'Bạn không có quyền admin.');
    const type = String(action.type || '');
    if (type === 'kick' || type === 'ban') {
      const target = io.sockets.sockets.get(String(action.id || ''));
      if (!target || target.data.isAdmin) return socket.emit('admin:error', 'Không tìm thấy người chơi hợp lệ.');
      const targetName = target.data.username;
      const roomId = playerRoom.get(target.id);
      if (type === 'ban' && targetName) bannedNames.add(usernameKey(targetName));
      target.emit(type === 'ban' ? 'banned' : 'kicked', type === 'ban' ? 'Bạn đã bị admin cấm khỏi server.' : 'Bạn đã bị admin đá khỏi phòng.');
      removeFromRoom(target);
      target.disconnect(true);
    } else if (type === 'closeRoom') {
      const roomId = String(action.roomId || '');
      const room = rooms.get(roomId);
      if (room) {
        for (const id of [...room.players.keys()]) {
          const target = io.sockets.sockets.get(id);
          if (target) { target.emit('roomClosed', 'Phòng đã bị admin đóng.'); removeFromRoom(target); }
        }
        rooms.delete(roomId);
      }
    } else if (type === 'lock') serverLocked = true;
    else if (type === 'unlock') serverLocked = false;
    else if (type === 'announce') {
      announcement = String(action.message || '').trim().slice(0, 180);
      if (announcement) io.emit('serverAnnouncement', announcement);
    } else if (type === 'unban') bannedNames.delete(usernameKey(action.username));
    else if (type === 'heal' || type === 'speed') {
      const target = io.sockets.sockets.get(String(action.id || ''));
      if (target && playerRoom.has(target.id)) target.emit('admin:received', { type: type === 'heal' ? 'health' : 'speed', value: type === 'heal' ? 100 : true });
    } else return socket.emit('admin:error', 'Lệnh admin không hợp lệ.');
    broadcastAdminState();
    socket.emit('admin:state', adminSnapshot());
  });

  socket.on('joinRoom', (payload = {}) => {
    if (!socket.data.userId || !socket.data.username) return socket.emit('joinError', 'Bạn cần đăng nhập tài khoản trước.');
    const roomId = String(payload.roomId || '').trim();
    const username = socket.data.username;
    const format = String(payload.format || '1v1');
    const teamSize = Math.max(1, Math.min(5, parseInt(format, 10) || 1));
    const team = payload.team === 'blue' ? 'blue' : 'red';
    if (serverLocked) return socket.emit('joinError', 'Server đang được admin khóa.');
    if (bannedNames.has(usernameKey(username))) return socket.emit('joinError', 'Tài khoản này đã bị cấm.');
    if (!/^\d{5}$/.test(roomId)) return socket.emit('joinError', 'Mã phòng không hợp lệ.');
    let room = rooms.get(roomId);
    if (!room) { room = { players: new Map(), format, teamSize, started: false }; rooms.set(roomId, room); }
    if (room.started) return socket.emit('joinError', 'Trận đấu đã bắt đầu, không thể vào phòng.');
    if (room.format !== format) return socket.emit('joinError', 'Mã phòng này đang dùng chế độ khác.');
    if (room.players.size >= room.teamSize * 2) return socket.emit('joinError', 'Phòng đã đầy.');
    const teamCount = [...room.players.values()].filter(p => p.team === team).length;
    const chosenTeam = teamCount < room.teamSize ? team : (team === 'red' ? 'blue' : 'red');
    const chosenCount = [...room.players.values()].filter(p => p.team === chosenTeam).length;
    if (chosenCount >= room.teamSize) return socket.emit('joinError', 'Hai đội đã đầy.');
    removeFromRoom(socket);
    room.players.set(socket.id, { username, accountId: socket.data.userId, team: chosenTeam, x: 0, y: 0, z: 8, yaw: 0, hp: 100 });
    playerRoom.set(socket.id, roomId);
    socket.join(roomId);
    emitRoomState(roomId);
    broadcastAdminState();
  });

  socket.on('switchTeam', ({ team } = {}) => {
    const roomId = playerRoom.get(socket.id); const room = roomId && rooms.get(roomId); const player = room && room.players.get(socket.id);
    if (!player || room.started || !['red', 'blue'].includes(team)) return;
    const count = [...room.players.values()].filter(p => p.team === team).length;
    if (count >= room.teamSize) return socket.emit('joinError', 'Đội kia đã đầy!');
    player.team = team; emitRoomState(roomId); broadcastAdminState();
  });
  socket.on('startMatch', () => {
    const roomId = playerRoom.get(socket.id); const room = roomId && rooms.get(roomId);
    if (!room) return;
    if (room.players.size < room.teamSize * 2) return socket.emit('joinError', 'Chưa đủ người chơi để bắt đầu.');
    room.started = true; io.to(roomId).emit('matchStarted'); broadcastAdminState();
  });
  socket.on('playerUpdate', (data = {}) => {
    const roomId = playerRoom.get(socket.id); const room = roomId && rooms.get(roomId); const player = room && room.players.get(socket.id);
    if (!player) return;
    for (const key of ['x', 'y', 'z', 'yaw', 'hp']) { const value = Number(data[key]); if (Number.isFinite(value)) player[key] = value; }
    socket.to(roomId).emit('playerMoved', { id: socket.id, x: player.x, y: player.y, z: player.z, yaw: player.yaw });
  });
  socket.on('shoot', data => { const roomId = playerRoom.get(socket.id); if (roomId) socket.to(roomId).emit('playerShot', { id: socket.id, origin: data?.origin, direction: data?.direction }); });
  socket.on('leaveRoom', () => removeFromRoom(socket));
  socket.on('disconnect', () => { removeFromRoom(socket); broadcastAdminState(); });
});

async function start() {
  if (pool) {
    await pool.query(`CREATE TABLE IF NOT EXISTS game_accounts (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(16) NOT NULL,
      username_key VARCHAR(32) NOT NULL UNIQUE,
      password_salt VARCHAR(64) NOT NULL,
      password_hash VARCHAR(128) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    console.log('Account storage: PostgreSQL connected.');
  } else {
    console.warn('WARNING: DATABASE_URL is not set. Accounts are temporary and reset when the server restarts.');
  }
  server.listen(PORT, '0.0.0.0', () => console.log(`Tuan FF server listening on port ${PORT}`));
}
start().catch(error => { console.error('Server startup failed:', error); process.exit(1); });
