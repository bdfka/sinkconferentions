/* ============================================================
   SinkConferentions — Signaling Server (v3)
   Комнаты живут в Supabase, память — только кэш
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

// ---------- CORS ----------
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map(s => s.trim());

const io = new Server(server, {
  cors: {
    origin: allowedOrigins.includes('*') ? true : allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 5e6,
  pingTimeout: 60000,
  pingInterval: 25000
});

// ---------- Supabase ----------
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  '';

const hasSupabase = !!(SUPABASE_URL && SUPABASE_KEY);

let supabase = null;
if (hasSupabase) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
  });
}

// ---------- Express ----------
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Раздаём папку public на уровень выше server/
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

console.log('[paths] public dir:', PUBLIC_DIR);

// ============================================================
// Память (быстрый кэш для WebRTC-сигналинга)
// ============================================================
const rooms = new Map();          // roomId -> { participants: Map, adminId, boardEnabled, whiteboardData }
const subscriptions = new Map();

const PLANS = {
  free:  { name: 'Free',  maxParticipants: 5 },
  start: { name: 'Start', maxParticipants: 25 },
  pro:   { name: 'Pro',   maxParticipants: 200 }
};

function generateRoomId() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let id = '';
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// ---------- Получить или создать комнату ----------
async function getOrCreateRoom(roomId, adminSocketId = null) {
  const key = roomId.toUpperCase();
  let room = rooms.get(key);

  if (!room) {
    room = {
      id: key,
      participants: new Map(),
      adminId: adminSocketId,
      boardEnabled: true,
      whiteboardData: null,
      createdAt: Date.now()
    };
    rooms.set(key, room);
  }

  // Фоном пишем в Supabase, чтобы комната пережила рестарт
  if (hasSupabase) {
    supabase
      .from('rooms')
      .upsert({
        id: key,
        admin_id: room.adminId,
        board_enabled: room.boardEnabled,
        updated_at: new Date().toISOString()
      }, { onConflict: 'id' })
      .then(({ error }) => {
        if (error) console.warn('[room upsert]', error.message);
      });
  }

  return room;
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
// Socket.IO
// ============================================================
io.on('connection', (socket) => {
  console.log('[+] Connected:', socket.id);

  // ---------- Создание комнаты ----------
  socket.on('create-room', async ({ userName, isAuthenticated } = {}, callback) => {
    try {
      const roomId = generateRoomId();
      const adminId = isAuthenticated ? socket.id : null;
      const room = await getOrCreateRoom(roomId, adminId);

      room.participants.set(socket.id, {
        name: userName || 'Гость',
        isAdmin: !!isAuthenticated,
        mediaState: { audio: true, video: true, screen: false },
        handRaised: false,
        joinedAt: Date.now()
      });

      socket.join(room.id);

      if (typeof callback === 'function') {
        callback({ roomId: room.id, isAdmin: !!isAuthenticated });
      }

      io.to(room.id).emit('room-update', serializeRoom(room));

      if (hasSupabase) {
        supabase.from('room_participants').insert({
          room_id: room.id,
          socket_id: socket.id,
          name: userName || 'Гость',
          is_admin: !!isAuthenticated
        }).then(({ error }) => {
          if (error) console.warn('[create-room participant]', error.message);
        });
      }
    } catch (e) {
      console.error('[create-room]', e);
      if (typeof callback === 'function') callback({ error: 'Ошибка сервера' });
    }
  });

  // ---------- Присоединение (комната создаётся автоматически) ----------
  socket.on('join-room', async ({ roomId, userName, isAuthenticated } = {}, callback) => {
    try {
      if (!roomId) {
        if (typeof callback === 'function') callback({ error: 'Не указан ID комнаты' });
        return;
      }

      const room = await getOrCreateRoom(roomId);

      const isAdmin =
        userName === 'bdfka' ||
        userName === 'Семён Иванов' ||
        isAuthenticated === true;

      room.participants.set(socket.id, {
        name: userName || 'Гость',
        isAdmin,
        mediaState: { audio: true, video: true, screen: false },
        handRaised: false,
        joinedAt: Date.now()
      });

      if (isAdmin) room.adminId = socket.id;

      socket.join(room.id);

      if (typeof callback === 'function') {
        callback({
          roomId: room.id,
          isAdmin,
          boardEnabled: room.boardEnabled,
          participants: serializeRoom(room).participants
        });
      }

      if (room.whiteboardData) {
        socket.emit('whiteboard-state', room.whiteboardData);
      }

      io.to(room.id).emit('room-update', serializeRoom(room));

      if (hasSupabase) {
        supabase.from('room_participants').insert({
          room_id: room.id,
          socket_id: socket.id,
          name: userName || 'Гость',
          is_admin: isAdmin
        }).then(({ error }) => {
          if (error) console.warn('[join-room participant]', error.message);
        });
      }

      console.log(`[join-room] ${userName} → ${room.id} (${room.participants.size} участников)`);
    } catch (e) {
      console.error('[join-room]', e);
      if (typeof callback === 'function') callback({ error: 'Ошибка сервера' });
    }
  });

  // ---------- WebRTC сигналинг ----------
  socket.on('offer', ({ targetId, offer }) => {
    if (targetId && offer) io.to(targetId).emit('offer', { fromId: socket.id, offer });
  });
  socket.on('answer', ({ targetId, answer }) => {
    if (targetId && answer) io.to(targetId).emit('answer', { fromId: socket.id, answer });
  });
  socket.on('ice-candidate', ({ targetId, candidate }) => {
    if (targetId && candidate) io.to(targetId).emit('ice-candidate', { fromId: socket.id, candidate });
  });

  // ---------- Медиа ----------
  socket.on('toggle-media', async ({ roomId, type, enabled }) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room) return;
    const p = room.participants.get(socket.id);
    if (!p) return;

    p.mediaState[type] = enabled;
    io.to(room.id).emit('media-update', { socketId: socket.id, type, enabled });
    io.to(room.id).emit('room-update', serializeRoom(room));

    if (hasSupabase && (type === 'audio' || type === 'video' || type === 'screen')) {
      supabase.from('room_participants')
        .update({ [type]: enabled, last_seen: new Date().toISOString() })
        .eq('socket_id', socket.id)
        .then(() => {});
    }
  });

  socket.on('admin-force-media', ({ roomId, targetId, type, enabled }) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room || socket.id !== room.adminId) return;
    io.to(targetId).emit('force-media-toggle', { type, enabled });
  });

  // ---------- Руки ----------
  socket.on('raise-hand', ({ roomId, raised }) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room) return;
    const p = room.participants.get(socket.id);
    if (!p) return;

    p.handRaised = raised;
    io.to(room.id).emit('hand-update', { socketId: socket.id, raised });
    io.to(room.id).emit('room-update', serializeRoom(room));
  });

  socket.on('lower-all-hands', ({ roomId }) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room || socket.id !== room.adminId) return;

    room.participants.forEach((p, id) => {
      p.handRaised = false;
      io.to(room.id).emit('hand-update', { socketId: id, raised: false });
    });
    io.to(room.id).emit('room-update', serializeRoom(room));
  });

  // ---------- Доска ----------
  socket.on('toggle-board-visibility', ({ roomId, enabled }) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room || socket.id !== room.adminId) return;
    room.boardEnabled = enabled;
    io.to(room.id).emit('board-visibility', enabled);
  });

  socket.on('save-whiteboard', ({ roomId, data }) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room) return;
    room.whiteboardData = data;
    socket.to(room.id).emit('whiteboard-draw', data);
  });

  socket.on('whiteboard-clear', ({ roomId }) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room) return;
    room.whiteboardData = null;
    io.to(room.id).emit('whiteboard-clear');
  });

  // ---------- Чат ----------
  socket.on('chat-message', async ({ roomId, message } = {}) => {
    if (!message) return;
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room) return;
    const sender = room.participants.get(socket.id);
    if (!sender) return;

    const payload = {
      id: message.id || uuidv4(),
      roomId: room.id,
      senderId: socket.id,
      senderName: sender.name,
      recipientId: message.recipientId || null,
      type: message.type,
      content: message.content,
      createdAt: new Date().toISOString()
    };

    if (hasSupabase) {
      supabase.from('messages').insert({
        id: payload.id,
        room_id: room.id,
        sender_id: socket.id,
        sender_name: sender.name,
        recipient_id: message.recipientId || null,
        type: message.type,
        content: message.content
      }).then(({ error }) => {
        if (error) console.warn('[chat insert]', error.message);
      });
    }

    if (message.recipientId) {
      io.to(socket.id).emit('chat-message', payload);
      io.to(message.recipientId).emit('chat-message', payload);
    } else {
      io.to(room.id).emit('chat-message', payload);
    }
  });

  socket.on('load-chat-history', async ({ roomId }, callback) => {
    if (typeof callback !== 'function') return;
    if (!hasSupabase) return callback({ messages: [] });

    try {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('room_id', (roomId || '').toUpperCase())
        .is('recipient_id', null)
        .order('created_at', { ascending: true })
        .limit(200);

      if (error) console.warn('[chat history]', error.message);
      callback({ messages: data || [] });
    } catch (e) {
      callback({ messages: [] });
    }
  });

  socket.on('typing', ({ roomId, recipientId, isTyping }) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room) return;
    const sender = room.participants.get(socket.id);
    if (!sender) return;

    const payload = { senderId: socket.id, senderName: sender.name, isTyping };
    if (recipientId) io.to(recipientId).emit('typing', payload);
    else socket.to(room.id).emit('typing', payload);
  });

  socket.on('poll-vote', async ({ roomId, messageId, optionIndex }) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room) return;
    const voter = room.participants.get(socket.id);
    if (!voter) return;
    if (!hasSupabase) return;

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

      io.to(room.id).emit('poll-update', { messageId, votes: votes || [] });
    } catch (e) {
      console.warn('[poll vote]', e.message);
    }
  });

  // ---------- Отключение ----------
  socket.on('disconnect', (reason) => {
    console.log('[-] Disconnected:', socket.id, '·', reason);

    rooms.forEach((room, roomId) => {
      if (room.participants.has(socket.id)) {
        room.participants.delete(socket.id);
        if (room.adminId === socket.id) room.adminId = null;

        io.to(room.id).emit('room-update', serializeRoom(room));

        if (hasSupabase) {
          supabase.from('room_participants')
            .delete()
            .eq('socket_id', socket.id)
            .then(() => {});
        }

        // Если комната пуста — удаляем из памяти через минуту
        if (room.participants.size === 0) {
          setTimeout(() => {
            const r = rooms.get(roomId);
            if (r && r.participants.size === 0) {
              rooms.delete(roomId);
              console.log('[room] cleaned from memory:', roomId);
            }
          }, 60000);
        }
      }
    });
  });
});

// ============================================================
// HTTP API
// ============================================================

function isAdminReq(req) {
  return req.headers['x-admin-key'] === process.env.ADMIN_MASTER_KEY;
}

// ---------- Список участников комнаты ----------
app.get('/api/rooms/:roomId/participants', async (req, res) => {
  const roomId = (req.params.roomId || '').toUpperCase();
  const room = rooms.get(roomId);

  if (room) {
    return res.json({
      source: 'memory',
      participants: serializeRoom(room).participants,
      boardEnabled: room.boardEnabled
    });
  }

  if (hasSupabase) {
    const { data } = await supabase
      .from('room_participants')
      .select('*')
      .eq('room_id', roomId);

    return res.json({
      source: 'supabase',
      participants: (data || []).map(p => ({
        id: p.socket_id,
        name: p.name,
        isAdmin: p.is_admin,
        mediaState: { audio: p.audio, video: p.video, screen: p.screen },
        handRaised: p.hand_raised,
        joinedAt: new Date(p.joined_at).getTime()
      }))
    });
  }

  res.json({ participants: [] });
});

// ---------- Проверка комнаты ----------
app.get('/api/rooms/:roomId', async (req, res) => {
  const roomId = (req.params.roomId || '').toUpperCase();
  const room = rooms.get(roomId);

  if (room) {
    return res.json({ exists: true, source: 'memory', participants: room.participants.size });
  }

  if (hasSupabase) {
    const { data } = await supabase
      .from('rooms')
      .select('id')
      .eq('id', roomId)
      .maybeSingle();
    return res.json({ exists: !!data, source: 'supabase' });
  }

  res.json({ exists: false });
});

// ---------- Регистрация ----------
app.post('/api/register', async (req, res) => {
  const { name, email, login, password } = req.body || {};
  if (!name || !email || !login || !password) {
    return res.status(400).json({ error: 'Все поля обязательны' });
  }

  if (!hasSupabase) {
    return res.json({
      ok: true,
      user: { id: 'local_' + Date.now(), name, email, login, plan: 'free' }
    });
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .insert({
        name,
        email: email.toLowerCase(),
        login: login.toLowerCase(),
        password_hash: password,
        is_admin: login.toLowerCase() === (process.env.ADMIN_LOGIN || 'bdfka'),
        plan: login.toLowerCase() === (process.env.ADMIN_LOGIN || 'bdfka') ? 'pro' : 'free'
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ ok: true, user: data });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- Вход ----------
app.post('/api/login', async (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password) {
    return res.status(400).json({ error: 'Заполните поля' });
  }

  if (!hasSupabase) {
    return res.json({
      ok: true,
      user: { id: 'local', name: identifier, login: identifier, plan: 'free' }
    });
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

// ---------- Подписки ----------
app.get('/api/subscription/:userId', (req, res) => {
  res.json({ subscription: subscriptions.get(req.params.userId) || { plan: 'free' } });
});

app.post('/api/admin/subscription', (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: 'Доступ запрещён' });

  const { userId, plan, days, issuedBy } = req.body || {};
  if (!userId || !plan) return res.status(400).json({ error: 'userId и plan обязательны' });
  if (!PLANS[plan]) return res.status(400).json({ error: 'Неизвестный тариф' });

  const sub = {
    userId,
    plan,
    expiresAt: days ? Date.now() + days * 86400000 : null,
    issuedBy: issuedBy || 'bdfka',
    issuedAt: Date.now()
  };

  subscriptions.set(userId, sub);
  res.json({ ok: true, subscription: sub });
});

app.get('/api/admin/subscriptions', (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: 'Доступ запрещён' });
  res.json({ subscriptions: Array.from(subscriptions.values()) });
});

app.delete('/api/admin/subscription/:userId', (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: 'Доступ запрещён' });
  subscriptions.delete(req.params.userId);
  res.json({ ok: true });
});

app.get('/api/plans', (req, res) => res.json({ plans: PLANS }));

// ---------- Health ----------
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    rooms: rooms.size,
    subscriptions: subscriptions.size,
    supabase: hasSupabase,
    uptime: process.uptime(),
    version: '3.0.0',
    port: process.env.PORT || 3001
  });
});

// ---------- Fallback для SPA ----------
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
    if (err) next();
  });
});

// ============================================================
// ЗАПУСК
// ============================================================
const PORT = process.env.PORT || 3001;

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ╔════════════════════════════════════════════╗');
  console.log('  ║   SinkConferentions Server v3.0.0          ║');
  console.log('  ╚════════════════════════════════════════════╝');
  console.log(`  Порт: ${PORT}`);
  console.log(`  Админ: ${process.env.ADMIN_LOGIN || 'bdfka'}`);
  console.log(`  Supabase: ${hasSupabase ? '✅ подключён' : '⚠️  НЕ настроен'}`);
  console.log(`  Public: ${PUBLIC_DIR}`);
  console.log(`  URL: ${process.env.RENDER_EXTERNAL_URL || 'http://localhost:' + PORT}`);
  console.log('');
});
