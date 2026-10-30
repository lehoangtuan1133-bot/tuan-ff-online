const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-this-password";
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");

// In-memory state: rooms, connected players and bans reset when the Render
// instance restarts. Use a database for permanent accounts/ban history.
const rooms = new Map();
const players = new Map();
const bans = new Set();
let serverLocked = false;
let announcement = "";

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function makeToken(username) {
  const payload = Buffer.from(JSON.stringify({
    username, exp: Date.now() + 12 * 60 * 60 * 1000
  })).toString("base64url");
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(payload).digest("base64url");
  return payload + "." + sig;
}
function verifyToken(token) {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", JWT_SECRET).update(payload).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!data.username || data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}
function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const data = verifyToken(token);
  if (!data || data.username !== ADMIN_USERNAME) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}
function publicState() {
  return {
    locked: serverLocked,
    announcement,
    online: [...players.values()].map(p => ({
      id: p.id, name: p.name, room: p.room || null
    })),
    rooms: [...rooms.entries()].map(([id, room]) => ({
      id, players: [...room.players]
    }))
  };
}
function emitAdminUpdate() {
  io.to("admins").emit("admin:update", publicState());
}

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><title>Game server</title></head>
  <body style="font:16px Arial;padding:32px"><h2>Game server is running</h2>
  <p>Socket.IO endpoint is ready.</p><p>Admin panel: <a href="/admin">/admin</a></p></body></html>`);
});
app.get("/health", (_req, res) => res.json({ ok: true, port: PORT }));
app.get("/api/status", (_req, res) => res.json({
  ok: true, locked: serverLocked, online: players.size, roomCount: rooms.size
}));
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!safeEqual(username || "", ADMIN_USERNAME) || !safeEqual(password || "", ADMIN_PASSWORD)) {
    return res.status(401).json({ error: "Sai tên đăng nhập hoặc mật khẩu." });
  }
  res.json({ token: makeToken(ADMIN_USERNAME), username: ADMIN_USERNAME });
});
app.get("/api/admin/state", requireAdmin, (_req, res) => res.json(publicState()));
app.post("/api/admin/lock", requireAdmin, (req, res) => {
  serverLocked = !!req.body.locked;
  io.emit("server:lock", { locked: serverLocked });
  emitAdminUpdate();
  res.json({ ok: true, locked: serverLocked });
});
app.post("/api/admin/announcement", requireAdmin, (req, res) => {
  announcement = String(req.body.message || "").slice(0, 500);
  io.emit("server:announcement", { message: announcement });
  emitAdminUpdate();
  res.json({ ok: true });
});
app.post("/api/admin/kick", requireAdmin, (req, res) => {
  const socket = io.sockets.sockets.get(String(req.body.socketId || ""));
  if (!socket) return res.status(404).json({ error: "Không tìm thấy người chơi." });
  socket.emit("player:kicked", { message: "Bạn đã bị quản trị viên ngắt kết nối." });
  socket.disconnect(true);
  res.json({ ok: true });
});
app.post("/api/admin/ban", requireAdmin, (req, res) => {
  const id = String(req.body.socketId || "");
  const socket = io.sockets.sockets.get(id);
  if (!socket) return res.status(404).json({ error: "Không tìm thấy người chơi." });
  bans.add(id);
  socket.emit("player:banned", { message: "Bạn đã bị chặn khỏi máy chủ." });
  socket.disconnect(true);
  res.json({ ok: true });
});
app.get("/admin", (_req, res) => res.sendFile(__dirname + "/admin.html"));

io.on("connection", socket => {
  const requestedName = String(socket.handshake.auth?.name || socket.handshake.query?.name || "Người chơi").trim();
  const name = requestedName.slice(0, 24) || "Người chơi";
  if (serverLocked) {
    socket.emit("server:lock", { locked: true });
    socket.disconnect(true);
    return;
  }
  if (bans.has(socket.id)) {
    socket.disconnect(true);
    return;
  }
  players.set(socket.id, { id: socket.id, name, room: null });
  socket.emit("server:announcement", { message: announcement });
  emitAdminUpdate();

  // Client events: room:create, room:join, room:leave, game:state, game:action.
  socket.on("room:create", (data = {}, ack = () => {}) => {
    const roomId = String(data.roomId || crypto.randomBytes(3).toString("hex")).slice(0, 12);
    if (rooms.has(roomId)) return ack({ ok: false, error: "Phòng đã tồn tại." });
    rooms.set(roomId, { players: new Set(), state: null });
    joinRoom(roomId);
    ack({ ok: true, roomId });
  });
  socket.on("room:join", (data = {}, ack = () => {}) => {
    const roomId = String(data.roomId || "").trim().slice(0, 12);
    if (!rooms.has(roomId)) return ack({ ok: false, error: "Không tìm thấy phòng." });
    joinRoom(roomId);
    ack({ ok: true, roomId, state: rooms.get(roomId).state });
  });
  function joinRoom(roomId) {
    const player = players.get(socket.id);
    if (!player) return;
    if (player.room && rooms.has(player.room)) {
      rooms.get(player.room).players.delete(socket.id);
      socket.leave(player.room);
      if (rooms.get(player.room).players.size === 0) rooms.delete(player.room);
    }
    player.room = roomId;
    rooms.get(roomId).players.add(socket.id);
    socket.join(roomId);
    io.to(roomId).emit("room:players", [...rooms.get(roomId).players].map(id => {
      const p = players.get(id); return p ? { id: p.id, name: p.name } : null;
    }).filter(Boolean));
    emitAdminUpdate();
  }
  socket.on("room:leave", () => {
    const p = players.get(socket.id);
    if (p?.room && rooms.has(p.room)) {
      const roomId = p.room;
      rooms.get(roomId).players.delete(socket.id);
      socket.leave(roomId);
      p.room = null;
      if (rooms.get(roomId).players.size === 0) rooms.delete(roomId);
      io.to(roomId).emit("room:players", [...(rooms.get(roomId)?.players || [])].map(id => {
        const x = players.get(id); return x ? { id: x.id, name: x.name } : null;
      }).filter(Boolean));
      emitAdminUpdate();
    }
  });
  socket.on("game:state", data => {
    const p = players.get(socket.id);
    if (!p?.room || !rooms.has(p.room)) return;
    rooms.get(p.room).state = data;
    socket.to(p.room).emit("game:state", data);
  });
  socket.on("game:action", data => {
    const p = players.get(socket.id);
    if (p?.room) socket.to(p.room).emit("game:action", data);
  });
  socket.on("admin:join", token => {
    const data = verifyToken(token);
    if (data?.username === ADMIN_USERNAME) {
      socket.join("admins");
      socket.emit("admin:update", publicState());
    }
  });
  socket.on("disconnect", () => {
    const p = players.get(socket.id);
    if (p?.room && rooms.has(p.room)) {
      const roomId = p.room;
      rooms.get(roomId).players.delete(socket.id);
      if (rooms.get(roomId).players.size === 0) rooms.delete(roomId);
      io.to(roomId).emit("room:players", [...(rooms.get(roomId)?.players || [])].map(id => {
        const x = players.get(id); return x ? { id: x.id, name: x.name } : null;
      }).filter(Boolean));
    }
    players.delete(socket.id);
    emitAdminUpdate();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
