/* ============================================================
   SinkConferentions — Signaling Server
   Node.js + Socket.IO + Express + Supabase
   ============================================================ */

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.ALLOWED_ORIGINS || '*', credentials: true },
  maxHttpBufferSize: 5e6 // 5 MB на сообщение
});

// ---------- Supabase ----------
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || ''
);

// ---------- Middleware ----------
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- Состояние в памяти ----------
const rooms = new Map(); // roomId -> { participants, adminId, boardEnabled, whiteboardData }
const subscriptions = new Map(); // userId -> { plan, expiresAt, issuedBy, issuedAt }

const PLANS = {
  free:  { name: 'Free',  maxParticipants: 5,   maxDuration: 40 * 60,     videoQuality: '720p' },
  start: { name: 'Start', maxParticipants: 25,  maxDuration: 4 * 3600,    videoQuality: '1080p' },
  pro:   { name: 'Pro',   maxParticipants: 200, maxDuration: Infinity,    videoQuality: '4K' }
};

// ============================================================
// РАБОТА С КОМНАТАМИ
// ============================================================

function generateRoomId() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let id = '';
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function initRoom(roomId, adminSocketId = null) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      participants: new Map(),
      adminId: adminSocketId,
      boardEnabled: true,
      whiteboardData: null,
      createdAt: Date.now()
    });
  }
  return rooms.get(roomId);
}

function serializeRoom(room) {
  return {
    id: room.id,
    participants: Array.from(room.participants.entries()).map(([id, p]) => ({
      id,
      name: p.name,
      isAdmin: p.isAdmin,
      mediaState: p.mediaState,
      handRaised: p.handRaised,
      joinedAt: p.joinedAt
    })),
    adminId: room.adminId,
    boardEnabled: room.boardEnabled
  };
}

// ============================================================
// SOCKET.IO
// ============================================================

io.on('connection', (socket) => {
  console.log('[+] Connected:', socket.id);

  // ---------- Создание комнаты ----------
  socket.on('create-room', ({ userName, isAuthenticated }, callback) => {
    const roomId = generateRoomId();
    const adminId = isAuthenticated ? socket.id : null;
    const room = initRoom(roomId, adminId);

    room.participants.set(socket.id, {
      name: userName || 'Гость',
      isAdmin: isAuthenticated,
      mediaState: { audio: true, video: true, screen: false },
      handRaised: false,
      joinedAt: Date.now()
    });

    socket.join(roomId);
    callback({ roomId, isAdmin: isAuthenticated });
    io.to(roomId).emit('room-update', serializeRoom(room));
  });

  // ---------- Присоединение ----------
  socket.on('join-room', ({ roomId, userName, isAuthenticated }, callback) => {
    const room = rooms.get(roomId);
    if (!room) return callback({ error: 'Комната не найдена' });

    // bdfka (Семён Иванов) всегда админ
    const isAdmin = userName === 'bdfka' || userName === 'Семён Иванов' || isAuthenticated === true;

    room.participants.set(socket.id, {
      name: userName || 'Гость',
      isAdmin,
      mediaState: { audio: true, video: true, screen: false },
      handRaised: false,
      joinedAt: Date.now()
    });

    if (isAdmin) room.adminId = socket.id;

    socket.join(roomId);
    callback({ roomId, isAdmin, boardEnabled: room.boardEnabled });

    if (room.whiteboardData) {
      socket.emit('whiteboard-state', room.whiteboardData);
    }

    io.to(roomId).emit('room-update', serializeRoom(room));
  });

  // ---------- WebRTC Signaling ----------
  socket.on('offer', ({ targetId, offer }) => {
    io.to(targetId).emit('offer', { fromId: socket.id, offer });
  });

  socket.on('answer', ({ targetId, answer }) => {
    io.to(targetId).emit('answer', { fromId: socket.id, answer });
  });

  socket.on('ice-candidate', ({ targetId, candidate }) => {
    io.to(targetId).emit('ice-candidate', { fromId: socket.id, candidate });
  });

  // ---------- Медиа ----------
  socket.on('toggle-media', ({ roomId, type, enabled }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const p = room.participants.get(socket.id);
    if (p) {
      p.mediaState[type] = enabled;
      io.to(roomId).emit('media-update', { socketId: socket.id, type, enabled });
      io.to(roomId).emit('room-update', serializeRoom(room));
    }
  });

  socket.on('admin-force-media', ({ roomId, targetId, type, enabled }) => {
    const room = rooms.get(roomId);
    if (!room || socket.id !== room.adminId) return;
    io.to(targetId).emit('force-media-toggle', { type, enabled });
    io.to(roomId).emit('admin-action', { action: 'force-media', targetId, type, enabled });
  });

  // ---------- Руки ----------
  socket.on('raise-hand', ({ roomId, raised }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const p = room.participants.get(socket.id);
    if (p) {
      p.handRaised = raised;
      io.to(roomId).emit('hand-update', { socketId: socket.id, raised });
    }
  });

  socket.on('lower-all-hands', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || socket.id !== room.adminId) return;
    room.participants.forEach((p, id) => {
      p.handRaised = false;
      io.to(roomId).emit('hand-update', { socketId: id, raised: false });
    });
  });

  // ---------- Доска ----------
  socket.on('toggle-board-visibility', ({ roomId, enabled }) => {
    const room = rooms.get(roomId);
    if (!room || socket.id !== room.adminId) return;
    room.boardEnabled = enabled;
    io.to(roomId).emit('board-visibility', enabled);
  });

  socket.on('save-whiteboard', ({ roomId, data }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.whiteboardData = data;
    socket.to(roomId).emit('whiteboard-draw', data);
  });

  socket.on('whiteboard-clear', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.whiteboardData = null;
    io.to(roomId).emit('whiteboard-clear');
  });

  // ---------- Чат ----------
  socket.on('chat-message', async ({ roomId, message }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const sender = room.participants.get(socket.id);
    if (!sender) return;

    const payload = {
      id: message.id || uuidv4(),
      roomId,
      senderId: socket.id,
      senderName: sender.name,
      recipientId: message.recipientId || null,
      type: message.type,
      content: message.content,
      createdAt: new Date().toISOString()
    };

    // Supabase сохранение (если настроен)
    if (supabase) {
      try {
        await supabase.from('messages').insert({
          id: payload.id,
          room_id: roomId,
          sender_id: socket.id,
          sender_name: sender.name,
          recipient_id: message.recipientId || null,
          type: message.type,
          content: message.content
        });
      } catch (e) { /* ignore */ }
    }

    if (message.recipientId) {
      io.to(socket.id).emit('chat-message', payload);
      io.to(message.recipientId).emit('chat-message', payload);
    } else {
      io.to(roomId).emit('chat-message', payload);
    }
  });

  socket.on('typing', ({ roomId, recipientId, isTyping }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const sender = room.participants.get(socket.id);
    if (!sender) return;

    const payload = { senderId: socket.id, senderName: sender.name, isTyping };
    if (recipientId) {
      io.to(recipientId).emit('typing', payload);
    } else {
      socket.to(roomId).emit('typing', payload);
    }
  });

  socket.on('poll-vote', async ({ roomId, messageId, optionIndex }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const voter = room.participants.get(socket.id);
    if (!voter) return;

    if (supabase) {
      try {
        await supabase.from('poll_votes').upsert({
          message_id: messageId,
          voter_id: socket.id,
          voter_name: voter.name,
          option_index: optionIndex
        }, { onConflict: 'message_id,voter_id' });

        const { data: votes } = await supabase
          .from('poll_votes')
          .select('option_index, voter_id, voter_name')
          .eq('message_id', messageId);

        io.to(roomId).emit('poll-update', { messageId, votes: votes || [] });
      } catch (e) { /* ignore */ }
    }
  });

  // ---------- Отключение ----------
  socket.on('disconnect', () => {
    console.log('[-] Disconnected:', socket.id);
    rooms.forEach((room, roomId) => {
      if (room.participants.has(socket.id)) {
        room.participants.delete(socket.id);
        if (room.adminId === socket.id) room.adminId = null;
        io.to(roomId).emit('room-update', serializeRoom(room));
        if (room.participants.size === 0) rooms.delete(roomId);
      }
    });
  });
});

// ============================================================
// HTTP API — аккаунты, подписки, тикеты
// ============================================================

// Проверка что это админ
function isAdmin(req) {
  const key = req.headers['x-admin-key'];
  return key === process.env.ADMIN_MASTER_KEY;
}

// ---------- Регистрация ----------
app.post('/api/register', async (req, res) => {
  const { name, email, login, password } = req.body;
  if (!name || !email || !login || !password) {
    return res.status(400).json({ error: 'Все поля обязательны' });
  }

  if (!supabase) {
    // Fallback без Supabase — возвращаем успех (клиент хранит локально)
    return res.json({ ok: true, user: { id: 'local_' + Date.now(), name, email, login, plan: 'free' } });
  }

  try {
    // Создаём пользователя
    const { data: user, error } = await supabase
      .from('users')
      .insert({
        name, email: email.toLowerCase(), login: login.toLowerCase(),
        password_hash: password, // В проде — bcrypt
        is_admin: login.toLowerCase() === process.env.ADMIN_LOGIN,
        plan: login.toLowerCase() === process.env.ADMIN_LOGIN ? 'pro' : 'free'
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ ok: true, user });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- Вход ----------
app.post('/api/login', async (req, res) => {
  const { identifier, password } = req.body;
  if (!identifier || !password) return res.status(400).json({ error: 'Заполните поля' });

  if (!supabase) {
    return res.json({ ok: true, user: { id: 'local', name: identifier, login: identifier, plan: 'free' } });
  }

  try {
    const { data: users, error } = await supabase
      .from('users')
      .select('*')
      .or(`email.eq.${identifier.toLowerCase()},login.eq.${identifier.toLowerCase()}`)
      .limit(1);

    if (error) throw error;
    const user = users[0];
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (user.password_hash !== password) return res.status(401).json({ error: 'Неверный пароль' });

    res.json({ ok: true, user });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- Получить подписку пользователя ----------
app.get('/api/subscription/:userId', (req, res) => {
  const sub = subscriptions.get(req.params.userId) || {
    plan: 'free',
    expiresAt: null,
    issuedBy: null,
    issuedAt: null
  };
  res.json({ subscription: sub });
});

// ---------- Выдать/изменить подписку (только админ) ----------
app.post('/api/admin/subscription', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Доступ запрещён' });

  const { userId, plan, days, issuedBy } = req.body;
  if (!userId || !plan) return res.status(400).json({ error: 'userId и plan обязательны' });
  if (!PLANS[plan]) return res.status(400).json({ error: 'Неизвестный тариф' });

  const sub = {
    userId,
    plan,
    expiresAt: days ? Date.now() + days * 86400000 : null, // null = бессрочно
    issuedBy: issuedBy || 'bdfka',
    issuedAt: Date.now()
  };

  subscriptions.set(userId, sub);
  console.log(`[ADMIN] Подписка ${plan} выдана пользователю ${userId} на ${days || '∞'} дней`);
  res.json({ ok: true, subscription: sub });
});

// ---------- Список всех подписок (только админ) ----------
app.get('/api/admin/subscriptions', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Доступ запрещён' });
  res.json({ subscriptions: Array.from(subscriptions.values()) });
});

// ---------- Отозвать подписку ----------
app.delete('/api/admin/subscription/:userId', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Доступ запрещён' });
  subscriptions.delete(req.params.userId);
  res.json({ ok: true });
});

// ---------- Список тарифов ----------
app.get('/api/plans', (req, res) => {
  res.json({ plans: PLANS });
});

// ---------- Health check ----------
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    rooms: rooms.size,
    subscriptions: subscriptions.size,
    uptime: process.uptime()
  });
});

// ============================================================
// ЗАПУСК
// ============================================================
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`
  ╔════════════════════════════════════════════╗
  ║   SinkConferentions Server запущен         ║
  ║   Порт: ${PORT}                              ║
  ║   Админ: ${process.env.ADMIN_LOGIN || 'bdfka'}                          ║
  ╚════════════════════════════════════════════╝
  `);
});