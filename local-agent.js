#!/usr/bin/env node
// local-agent.js — Yayıncının Windows bilgisayarında çalışan yerel ajan
// Uzak sunucuya (ör. Render) bağlanır ve uzaktan kontrol komutlarını yerelde uygular.
//
// Kullanım:
//   node local-agent.js <sunucu-url> <oda-id>
//
// Örnek:
//   node local-agent.js https://socketsample.onrender.com abc1234567
//   node local-agent.js http://localhost:3000 abc1234567

const { io } = require('socket.io-client');
const RemoteInput = require('./remote-input');

// ——— Argümanları al ———
const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('');
  console.log('  Kullanım: node local-agent.js <sunucu-url> <oda-id>');
  console.log('');
  console.log('  Örnek:');
  console.log('    node local-agent.js https://socketsample.onrender.com abc1234567');
  console.log('    node local-agent.js http://localhost:3000 abc1234567');
  console.log('');
  process.exit(1);
}

const serverUrl = args[0];
const roomId = args[1];

console.log('');
console.log('  🤖 Yerel Ajan Başlatılıyor');
console.log(`  📡 Sunucu: ${serverUrl}`);
console.log(`  🏠 Oda: ${roomId}`);
console.log('');

// ——— RemoteInput başlat ———
const remoteInput = new RemoteInput();
remoteInput.init();

// RemoteInput hazır olduğunda bağlan
const waitReady = setInterval(() => {
  if (remoteInput.ready) {
    clearInterval(waitReady);
    connectToServer();
  }
}, 200);

// 10 saniye içinde hazır olmazsa yine de bağlan
setTimeout(() => {
  clearInterval(waitReady);
  if (!remoteInput.ready) {
    console.log('  ⚠ RemoteInput başlatılamadı, yine de bağlanılıyor...');
  }
  connectToServer();
}, 10000);

let connected = false;

function connectToServer() {
  if (connected) return;
  connected = true;

  const socket = io(serverUrl, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
  });

  socket.on('connect', () => {
    console.log(`  ✅ Sunucuya bağlandı (${socket.id})`);
    socket.emit('join-room', roomId, 'agent');
    console.log(`  🏠 Odaya katıldı: ${roomId}`);

    // Monitör bilgisini gönder
    const monitors = remoteInput.getMonitors();
    if (monitors.length > 0) {
      socket.emit('agent-monitor-info', { monitors });
      console.log(`  📺 ${monitors.length} monitör bildirildi`);
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`  ⚠ Bağlantı kesildi: ${reason}`);
  });

  socket.on('reconnect', (attempt) => {
    console.log(`  🔄 Yeniden bağlandı (deneme: ${attempt})`);
    socket.emit('join-room', roomId, 'agent');
  });

  // ——— Uzaktan kontrol komutlarını al ———
  socket.on('remote-input-relay', (data) => {
    if (!remoteInput.enabled) return;

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
  });

  // ——— Monitör seçimi ———
  socket.on('set-active-monitor', ({ width, height }) => {
    if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
      remoteInput.setActiveMonitorByResolution(width, height);
    }
  });

  // Temiz çıkış
  process.on('SIGINT', () => {
    console.log('\n  👋 Ajan kapatılıyor...');
    remoteInput.destroy();
    socket.disconnect();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    remoteInput.destroy();
    socket.disconnect();
    process.exit(0);
  });

  console.log('  ⏳ Uzaktan kontrol komutları bekleniyor...');
  console.log('  (Kapatmak için Ctrl+C)');
  console.log('');
}
