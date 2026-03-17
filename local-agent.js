#!/usr/bin/env node
// local-agent.js — Yayıncının Windows bilgisayarında çalışan yerel ajan
// Tarayıcı sayfası ile otomatik iletişim kurar, oda numarası gerekmez.
//
// Kullanım:
//   node local-agent.js [sunucu-url]
//   agent.exe [sunucu-url]
//
// sunucu-url verilmezse varsayılan kullanılır.

const http = require('http');
const { io } = require('socket.io-client');
const { exec } = require('child_process');
const os = require('os');
const RemoteInput = require('./remote-input');

const DEFAULT_SERVER = process.env.AGENT_SERVER_URL || 'https://socketsample.onrender.com';
const LOCAL_PORT = 9876;

console.log('');
console.log('  =========================================');
console.log('  \u{1F916}  Uzaktan Kontrol Ajan\u0131');
console.log('  =========================================');
console.log('');

// ——— RemoteInput başlat ———
const remoteInput = new RemoteInput();
remoteInput.init();

let remoteSocket = null;
let currentRoom = null;
let serverUrl = process.argv[2] || DEFAULT_SERVER;

// ——— Yerel HTTP API (tarayıcı sayfası ile iletişim) ———
const localServer = http.createServer((req, res) => {
  // CORS — HTTPS sayfasından localhost'a erişim izni
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // GET /status — ajan durumu
  if (req.url === '/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ready: remoteInput.ready,
      connected: !!(remoteSocket && remoteSocket.connected),
      room: currentRoom,
      monitors: remoteInput.getMonitors()
    }));
    return;
  }

  // POST /connect — tarayıcı sayfası oda bilgisini gönderir
  if (req.url === '/connect' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      if (body.length > 4096) return; // güvenlik limiti
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const url = typeof data.serverUrl === 'string' ? data.serverUrl : '';
        const roomId = typeof data.roomId === 'string' ? data.roomId : '';
        if (!url || !roomId || roomId.length > 50) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'serverUrl ve roomId gerekli' }));
          return;
        }
        connectToRemoteServer(url, roomId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, room: roomId }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Ge\u00e7ersiz istek' }));
      }
    });
    return;
  }

  // POST /set-monitor — monitör çözünürlüğü veya indeksi
  if (req.url === '/set-monitor' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      if (body.length > 1024) return;
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const { width, height, monitorIndex } = JSON.parse(body);
        if (typeof monitorIndex === 'number') {
          remoteInput.setActiveMonitorByIndex(monitorIndex);
        } else if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
          remoteInput.setActiveMonitorByResolution(width, height);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Ge\u00e7ersiz istek' }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

localServer.listen(LOCAL_PORT, '127.0.0.1', () => {
  console.log(`  \u2705 Yerel API dinleniyor: http://127.0.0.1:${LOCAL_PORT}`);
  console.log('  \uD83D\uDCE1 Taray\u0131c\u0131 a\u00e7\u0131l\u0131yor...');
  console.log('');

  // Tarayıcıyı aç
  if (serverUrl) {
    openBrowser(serverUrl);
  }

  console.log('  \u23F3 Yay\u0131n sayfas\u0131ndan oda bilgisi bekleniyor...');
  console.log('  (Kapatmak i\u00e7in Ctrl+C)');
  console.log('');
});

localServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`  \u26A0 Port ${LOCAL_PORT} zaten kullan\u0131mda \u2014 ba\u015fka bir ajan \u00e7al\u0131\u015f\u0131yor olabilir.`);
    process.exit(1);
  }
  console.error('  \u26A0 Yerel sunucu hatas\u0131:', err.message);
});

// ——— Tarayıcıyı Aç ———
function openBrowser(url) {
  const platform = os.platform();
  let cmd;
  if (platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else if (platform === 'darwin') {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd, (err) => {
    if (err) console.log('  \u26A0 Taray\u0131c\u0131 a\u00e7\u0131lamad\u0131:', err.message);
  });
}

// ——— Uzak Sunucuya Bağlan ———
function connectToRemoteServer(url, roomId) {
  // Zaten aynı odadaysak tekrar bağlanma
  if (remoteSocket && remoteSocket.connected && currentRoom === roomId) {
    console.log(`  \u2139\uFE0F  Zaten ${roomId} odas\u0131na ba\u011fl\u0131.`);
    return;
  }

  // Önceki bağlantıyı kapat
  if (remoteSocket) {
    remoteSocket.disconnect();
    remoteSocket = null;
  }

  serverUrl = url;
  currentRoom = roomId;

  console.log(`  \uD83D\uDD17 Sunucuya ba\u011flan\u0131l\u0131yor: ${url}`);
  console.log(`  \uD83C\uDFE0 Oda: ${roomId}`);

  remoteSocket = io(url, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
  });

  remoteSocket.on('connect', () => {
    console.log(`  \u2705 Sunucuya ba\u011fland\u0131 (${remoteSocket.id})`);
    remoteSocket.emit('join-room', roomId, 'agent');

    const monitors = remoteInput.getMonitors();
    if (monitors.length > 0) {
      remoteSocket.emit('agent-monitor-info', { monitors });
      console.log(`  \uD83D\uDCFA ${monitors.length} monit\u00f6r bildirildi`);
    }
  });

  remoteSocket.on('disconnect', (reason) => {
    console.log(`  \u26A0 Ba\u011flant\u0131 kesildi: ${reason}`);
  });

  remoteSocket.on('reconnect', () => {
    console.log('  \uD83D\uDD04 Yeniden ba\u011fland\u0131');
    remoteSocket.emit('join-room', roomId, 'agent');
  });

  // Uzaktan kontrol komutlarını al
  remoteSocket.on('remote-input-relay', (data) => {
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

  remoteSocket.on('set-active-monitor', ({ width, height, monitorIndex }) => {
    console.log(`  📺 set-active-monitor alındı: ${width}x${height}, monitorIndex=${monitorIndex}`);
    if (typeof monitorIndex === 'number' && monitorIndex >= 0) {
      remoteInput.setActiveMonitorByIndex(monitorIndex);
    } else if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
      remoteInput.setActiveMonitorByResolution(width, height);
    }
  });
}

// ——— Temiz Çıkış ———
function cleanup() {
  console.log('\n  \uD83D\uDC4B Ajan kapat\u0131l\u0131yor...');
  remoteInput.destroy();
  if (remoteSocket) remoteSocket.disconnect();
  localServer.close();
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
