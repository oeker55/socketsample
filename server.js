const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { Server } = require('socket.io');

// ——— Dosya Yükleme Klasörü ———
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Multer: uzantıyı koru, rastgele dosya adı
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '');
    const rand = crypto.randomBytes(12).toString('hex');
    cb(null, rand + (ext || ''));
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

function buildIceServers() {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
  ];

  const turnUrls = process.env.TURN_URLS;
  if (turnUrls) {
    // Kullanıcının kendi TURN sunucuları (env ile)
    iceServers.push({
      urls: turnUrls.split(',').map((url) => url.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  }

  return iceServers;
}

// Metered.ca API ile dinamik TURN credential alma
async function getMeteredTurnServers() {
  const apiKey = process.env.METERED_API_KEY || '556893d3fedd6e959c64507cc5475de0041e';
  const domain = process.env.METERED_DOMAIN || 'oeker55.metered.live';
  if (!apiKey) return null;
  try {
    const res = await fetch(`https://${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`);
    if (!res.ok) {
      console.warn('  ⚠ Metered.ca yanıt:', res.status, res.statusText);
      return null;
    }
    const servers = await res.json();
    console.log('  ✅ Metered.ca TURN sunucuları alındı:', servers.length, 'sunucu');
    return servers;
  } catch (e) {
    console.warn('  ⚠ Metered.ca TURN alınamadı:', e.message);
    return null;
  }
}

let iceServers = buildIceServers();

// ——— Uzaktan Kontrol Modülü ———
const RemoteInput = require('./remote-input');
const remoteInput = new RemoteInput();
remoteInput.init();

const controlSessions = {}; // roomId -> { viewerId }

app.use(express.static(path.join(__dirname, 'public')));

// ——— Dosya Yükleme Endpoint'i ———
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Dosya bulunamadı' });
  const url = '/uploads/' + req.file.filename;
  res.json({
    url,
    originalName: req.file.originalname,
    size: req.file.size,
    mimeType: req.file.mimetype,
  });
});

app.get('/config.js', async (req, res) => {
  res.type('application/javascript');
  // Metered.ca TURN sunucuları varsa ekle
  let servers = [...iceServers];
  const meteredServers = await getMeteredTurnServers();
  if (meteredServers && meteredServers.length > 0) {
    servers = servers.concat(meteredServers);
  }
  // TURN yoksa uyar
  const hasTurn = servers.some(s => {
    const u = Array.isArray(s.urls) ? s.urls[0] : (s.urls || '');
    return u.startsWith('turn');
  });
  if (!hasTurn) {
    console.warn('  ⚠ TURN sunucusu yapılandırılmamış! METERED_API_KEY veya TURN_URLS env değişkeni gerekli.');
  }
  res.send(`window.APP_CONFIG = ${JSON.stringify({ iceServers: servers })};`);
});

app.get('/api/monitors', (req, res) => {
  res.json({ monitors: remoteInput.getMonitors() });
});

// Ajan indirme endpoint'i
app.get('/download/agent.exe', (req, res) => {
  const agentPath = path.join(__dirname, 'public', 'agent.exe');
  if (!require('fs').existsSync(agentPath)) {
    return res.status(404).send('Agent dosyası bulunamadı');
  }
  res.download(agentPath, 'agent.exe');
});

// ——— Socket.IO Sinyalizasyon ———
io.on('connection', (socket) => {
  // Odaya katıl
  socket.on('join-room', (roomId, role) => {
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = role;
    socket.data.peerId = socket.id;

    if (role === 'viewer') {
      // Yayıncıya yeni izleyici bildirimi
      socket.to(roomId).emit('viewer-joined', { viewerId: socket.id });
    }

    if (role === 'agent') {
      console.log(`  🤖 Yerel ajan odaya katıldı: ${roomId}`);
    }
  });

  // Offer (yayıncı → izleyici)
  socket.on('offer', ({ viewerId, offer, broadcasterId }) => {
    io.to(viewerId).emit('offer', { broadcasterId, viewerId, offer });
  });

  // Answer (izleyici → yayıncı)
  socket.on('answer', ({ viewerId, answer }) => {
    const roomId = socket.data.roomId;
    socket.to(roomId).emit('answer', { viewerId, answer });
  });

  // ICE adayı
  socket.on('ice-candidate', ({ fromId, targetId, candidate }) => {
    io.to(targetId).emit('ice-candidate', { fromId, targetId, candidate });
  });

  // Chat mesajı
  socket.on('chat-message', (msg) => {
    const roomId = socket.data.roomId;
    socket.to(roomId).emit('chat-message', msg);
  });

  // Chat resim mesajı
  socket.on('chat-image', (msg) => {
    const roomId = socket.data.roomId;
    if (!msg || typeof msg.imageData !== 'string') return;
    if (!msg.imageData.startsWith('data:image/')) return;
    // ~2 MB base64 sınırı
    if (msg.imageData.length > 3_000_000) return;
    socket.to(roomId).emit('chat-image', msg);
  });

  // Chat dosya mesajı (sunucuya yüklenen dosyanın URL'i)
  socket.on('chat-file', (msg) => {
    const roomId = socket.data.roomId;
    if (!msg || typeof msg.url !== 'string') return;
    if (!msg.url.startsWith('/uploads/')) return;
    socket.to(roomId).emit('chat-file', msg);
  });

  // ——— Uzaktan Kontrol ———

  // İzleyici kontrol istiyor
  socket.on('control-request', ({ viewerName }) => {
    const roomId = socket.data.roomId;
    if (!roomId || socket.data.role !== 'viewer') return;
    if (controlSessions[roomId]) {
      socket.emit('control-denied');
      return;
    }
    socket.to(roomId).emit('control-request', {
      viewerId: socket.id,
      viewerName: String(viewerName || '').slice(0, 30)
    });
  });

  // Yayıncı yanıt veriyor
  socket.on('control-response', ({ viewerId, granted }) => {
    const roomId = socket.data.roomId;
    if (!roomId || socket.data.role !== 'broadcaster') return;
    if (granted) {
      controlSessions[roomId] = { viewerId };
      io.to(viewerId).emit('control-granted');
    } else {
      io.to(viewerId).emit('control-denied');
    }
  });

  // Yayıncı paylaşılan monitörü bildiriyor
  socket.on('set-active-monitor', ({ width, height, monitorIndex }) => {
    if (socket.data.role !== 'broadcaster') return;
    if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) return;

    console.log(`  📺 set-active-monitor: ${width}x${height}, monitorIndex=${monitorIndex}, localEnabled=${remoteInput.enabled}, monitors=${remoteInput.monitors.length}`);

    // Yerelde çalışıyorsa doğrudan ayarla
    if (remoteInput.enabled) {
      if (typeof monitorIndex === 'number' && monitorIndex >= 0) {
        remoteInput.setActiveMonitorByIndex(monitorIndex);
      } else {
        remoteInput.setActiveMonitorByResolution(width, height);
      }
    }
    // Ajana da ilet
    const roomId = socket.data.roomId;
    if (roomId) {
      const room = io.sockets.adapter.rooms.get(roomId);
      if (room) {
        for (const sid of room) {
          const s = io.sockets.sockets.get(sid);
          if (s && s.data.role === 'agent') {
            s.emit('set-active-monitor', { width, height, monitorIndex });
          }
        }
      }
    }
  });

  // Yayıncı kontrolü geri alıyor
  socket.on('control-revoke', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const session = controlSessions[roomId];
    if (session) {
      io.to(session.viewerId).emit('control-revoked');
      delete controlSessions[roomId];
    }
  });

  // İzleyici kontrolü bırakıyor
  socket.on('control-release', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const session = controlSessions[roomId];
    if (session && session.viewerId === socket.id) {
      socket.to(roomId).emit('control-released');
      delete controlSessions[roomId];
    }
  });

  // Uzak giriş olayları (fare/klavye)
  socket.on('remote-input', (data) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const session = controlSessions[roomId];
    if (!session || session.viewerId !== socket.id) return;

    // Sunucu yerelde çalışıyorsa doğrudan uygula
    if (remoteInput.enabled) {
      const t = data.type;
      if (t === 'mousemove') {
        remoteInput.moveMouse(data.nx, data.ny);
      } else if (t === 'mousedown') {
        remoteInput.moveMouse(data.nx, data.ny);
        remoteInput.mouseDown(data.button);
      } else if (t === 'mouseup') {
        remoteInput.moveMouse(data.nx, data.ny);
        remoteInput.mouseUp(data.button);
      } else if (t === 'scroll') {
        remoteInput.scroll(data.deltaY);
      } else if (t === 'keydown') {
        remoteInput.keyDown(data.keyCode);
      } else if (t === 'keyup') {
        remoteInput.keyUp(data.keyCode);
      }
    } else {
      // Uzak sunucu: odadaki yerle ajan'a ilet
      const room = io.sockets.adapter.rooms.get(roomId);
      if (room) {
        for (const sid of room) {
          const s = io.sockets.sockets.get(sid);
          if (s && s.data.role === 'agent') {
            s.emit('remote-input-relay', data);
            return;
          }
        }
      }
    }
  });

  // Ajan monitör bilgisi güncellemesi
  socket.on('agent-monitor-info', ({ monitors }) => {
    if (socket.data.role !== 'agent') return;
    console.log(`  🤖 Ajan monitör bilgisi:`, monitors);
  });

  // Yayıncı ayrıldı
  socket.on('broadcaster-left', () => {
    const roomId = socket.data.roomId;
    if (roomId) socket.to(roomId).emit('broadcaster-left');
  });

  // Bağlantı koptuğunda
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    // Kontrol oturumunu temizle
    const session = controlSessions[roomId];
    if (session) {
      if (socket.data.role === 'viewer' && session.viewerId === socket.id) {
        socket.to(roomId).emit('control-released');
        delete controlSessions[roomId];
      } else if (socket.data.role === 'broadcaster') {
        io.to(session.viewerId).emit('control-revoked');
        delete controlSessions[roomId];
      }
    }

    if (socket.data.role === 'viewer') {
      socket.to(roomId).emit('viewer-left', { viewerId: socket.id });
    } else if (socket.data.role === 'broadcaster') {
      socket.to(roomId).emit('broadcaster-left');
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n✅ Sunucu çalışıyor: http://localhost:${PORT}`);
  console.log('   Sinyalizasyon: Socket.IO');
  console.log('   ICE sunucuları:', iceServers.map((s) => s.urls).flat().join(', '));
  console.log('   (İzleyici linki yayın başladıktan sonra otomatik oluşturulur)\n');
});
