const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Aktif odaları tut: roomId -> { broadcasterId, viewers: [socketId] }
const rooms = new Map();

io.on('connection', (socket) => {
  console.log('[+] Bağlandı:', socket.id);

  // Yayıncı oda oluşturur
  socket.on('create-room', (callback) => {
    const roomId = uuidv4().replace(/-/g, '').slice(0, 10);
    rooms.set(roomId, { broadcasterId: socket.id, viewers: [] });
    socket.join(roomId);
    socket.roomId = roomId;
    socket.isBroadcaster = true;
    console.log('[+] Oda oluşturuldu:', roomId, '| Yayıncı:', socket.id);
    callback({ roomId });
  });

  // İzleyici odaya katılır
  socket.on('join-room', (roomId, callback) => {
    const room = rooms.get(roomId);
    if (!room) {
      callback({ error: 'Oda bulunamadı. Link geçersiz veya yayın sona ermiş olabilir.' });
      return;
    }
    room.viewers.push(socket.id);
    socket.join(roomId);
    socket.roomId = roomId;
    socket.isViewer = true;

    // Yayıncıya yeni izleyici bildir
    io.to(room.broadcasterId).emit('viewer-joined', socket.id);
    console.log('[+] İzleyici katıldı:', socket.id, '| Oda:', roomId);
    callback({ success: true, viewerCount: room.viewers.length });
  });

  // WebRTC Sinyalizasyon: Yayıncı → İzleyici (Offer)
  socket.on('offer', ({ viewerId, offer }) => {
    io.to(viewerId).emit('offer', { broadcasterId: socket.id, offer });
  });

  // WebRTC Sinyalizasyon: İzleyici → Yayıncı (Answer)
  socket.on('answer', ({ broadcasterId, answer }) => {
    io.to(broadcasterId).emit('answer', { viewerId: socket.id, answer });
  });

  // ICE Adayları değişimi
  socket.on('ice-candidate', ({ targetId, candidate }) => {
    io.to(targetId).emit('ice-candidate', { fromId: socket.id, candidate });
  });

  // Chat mesajı
  socket.on('chat-message', ({ text, name }) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms.has(roomId)) return;
    // XSS önlemi: sadece metin ilet, HTML kabul etme
    const safeText = String(text).slice(0, 500);
    const safeName = String(name || 'İsimsiz').slice(0, 30);
    const msg = { name: safeName, text: safeText, ts: Date.now(), isBroadcaster: !!socket.isBroadcaster };
    io.to(roomId).emit('chat-message', msg);
  });

  // Bağlantı kesildiğinde
  socket.on('disconnect', () => {
    console.log('[-] Ayrıldı:', socket.id);
    const roomId = socket.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    if (socket.isBroadcaster) {
      // Yayıncı ayrıldı → tüm izleyicilere bildir
      io.to(roomId).emit('broadcaster-left');
      rooms.delete(roomId);
      console.log('[-] Oda silindi:', roomId);
    } else if (socket.isViewer) {
      // İzleyici ayrıldı
      room.viewers = room.viewers.filter((id) => id !== socket.id);
      io.to(room.broadcasterId).emit('viewer-left', socket.id);
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`\n✅ Sunucu çalışıyor: http://localhost:${PORT}`);
  console.log('   Yayıncı sayfası: http://localhost:' + PORT);
  console.log('   (İzleyici linki yayın başladıktan sonra otomatik oluşturulur)\n');
});
