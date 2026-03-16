const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

function buildIceServers() {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  const turnUrls = process.env.TURN_URLS;
  if (turnUrls) {
    // Kullanıcının kendi TURN sunucuları (env ile)
    iceServers.push({
      urls: turnUrls.split(',').map((url) => url.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  } else {
    // Metered Open Relay – ücretsiz genel TURN sunucusu
    iceServers.push(
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turns:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    );
  }

  return iceServers;
}

const iceServers = buildIceServers();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`window.APP_CONFIG = ${JSON.stringify({ iceServers })};`);
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

  // Yayıncı ayrıldı
  socket.on('broadcaster-left', () => {
    const roomId = socket.data.roomId;
    if (roomId) socket.to(roomId).emit('broadcaster-left');
  });

  // Bağlantı koptuğunda
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
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
