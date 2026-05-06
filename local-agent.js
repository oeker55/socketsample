#!/usr/bin/env node
// local-agent.js — müşterinin bilgisayarında çalışan yerel uzaktan kontrol ajanı
// Tarayıcı sayfası veya royalstream-agent:// deep-link ile otomatik bağlanır.
//
// Kullanım:
//   node local-agent.js [sunucu-url]
//   agent.exe [sunucu-url]
//   royalstream-agent://connect?server=https%3A%2F%2Fdestek.example.com&room=abc
//
// sunucu-url verilmezse varsayılan kullanılır.

const http = require('http');
const { io } = require('socket.io-client');
const { exec, spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const RemoteInput = require('./remote-input');

const DEFAULT_SERVER = process.env.AGENT_SERVER_URL || 'https://socketsample.onrender.com';
const LOCAL_PORT = 9876;
const URL_PROTOCOL = 'royalstream-agent';
const AGENT_VERSION = '1.0.0';

function parseLaunchArgs(argv) {
  const out = {
    serverUrl: '',
    roomId: '',
    noBrowser: false,
    installOnly: false,
    portable: false,
  };

  for (const arg of argv) {
    if (!arg) continue;
    if (arg === '--no-browser') out.noBrowser = true;
    if (arg === '--install') out.installOnly = true;
    if (arg === '--portable') out.portable = true;
    if (arg.startsWith('--server=')) out.serverUrl = arg.slice('--server='.length);
    if (arg.startsWith('--room=')) out.roomId = arg.slice('--room='.length);
    if (/^https?:\/\//i.test(arg)) out.serverUrl = arg;
    if (arg.startsWith(URL_PROTOCOL + '://')) {
      try {
        const u = new URL(arg);
        out.serverUrl = u.searchParams.get('server') || out.serverUrl;
        out.roomId = u.searchParams.get('room') || u.searchParams.get('session') || out.roomId;
        out.noBrowser = true;
      } catch (e) {
        console.log('  ⚠ Deep-link okunamadı:', e.message);
      }
    }
  }

  return out;
}

function quoteWin(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function runWin(command) {
  return new Promise((resolve) => {
    exec(command, { windowsHide: true }, (err) => resolve(!err));
  });
}

async function registerWindowsProtocol(exePath) {
  const base = `HKCU\\Software\\Classes\\${URL_PROTOCOL}`;
  const command = `${quoteWin(exePath)} "%1"`;
  await runWin(`reg add "${base}" /ve /d "URL:Royal Stream Agent" /f`);
  await runWin(`reg add "${base}" /v "URL Protocol" /d "" /f`);
  await runWin(`reg add "${base}\\DefaultIcon" /ve /d ${quoteWin(exePath + ',0')} /f`);
  await runWin(`reg add "${base}\\shell\\open\\command" /ve /d ${quoteWin(command)} /f`);
}

async function maybeInstallWindows(argv, launch) {
  if (os.platform() !== 'win32' || !process.pkg || launch.portable) return false;

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const installDir = path.join(localAppData, 'RoyalStreamAgent');
  const installPath = path.join(installDir, 'RoyalStreamAgent.exe');
  const currentPath = process.execPath;
  const alreadyInstalled = currentPath.toLowerCase() === installPath.toLowerCase();

  fs.mkdirSync(installDir, { recursive: true });
  if (!alreadyInstalled) {
    fs.copyFileSync(currentPath, installPath);
  }

  await registerWindowsProtocol(installPath);
  console.log('  ✅ Agent kurulumu hazır:', installPath);

  if (launch.installOnly) {
    return true;
  }

  if (!alreadyInstalled) {
    const child = spawn(installPath, argv.filter((arg) => arg !== '--install'), {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return true;
  }

  return false;
}

const launch = parseLaunchArgs(process.argv.slice(2));

console.log('');
console.log('  =========================================');
console.log('  \u{1F916}  Uzaktan Kontrol Ajan\u0131');
console.log('  =========================================');
console.log('');

maybeInstallWindows(process.argv.slice(2), launch).then((shouldExit) => {
  if (shouldExit) process.exit(0);
  boot();
}).catch((err) => {
  console.log('  ⚠ Agent kurulumu hazırlanamadı:', err.message);
  boot();
});

function boot() {
// ——— RemoteInput başlat ———
const remoteInput = new RemoteInput();
remoteInput.init();

let remoteSocket = null;
let currentRoom = null;
let serverUrl = launch.serverUrl || DEFAULT_SERVER;
let shuttingDown = false;
let listenRetries = 0;
const parentPid = Number(process.env.AGENT_PARENT_PID || 0);

if (parentPid > 0 && os.platform() !== 'win32') {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch (err) {
      console.log('  ℹ Üst uygulama kapandı, ajan da kapatılıyor...');
      cleanup(0);
    }
  }, 1500).unref();
}

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
      version: AGENT_VERSION,
      ready: remoteInput.ready,
      connected: !!(remoteSocket && remoteSocket.connected),
      room: currentRoom,
      monitors: remoteInput.getMonitors()
    }));
    return;
  }

  // POST /shutdown — yeni ajan veya uygulama kapanışı eski ajanı temizleyebilir
  if (req.url === '/shutdown' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    setTimeout(() => cleanup(0), 50);
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
        const roomId = typeof data.roomId === 'string' ? data.roomId : (typeof data.sessionId === 'string' ? data.sessionId : '');
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

function startLocalServer() {
  localServer.listen(LOCAL_PORT, '127.0.0.1', () => {
  console.log(`  \u2705 Yerel API dinleniyor: http://127.0.0.1:${LOCAL_PORT}`);
  if (!launch.noBrowser) console.log('  \uD83D\uDCE1 Taray\u0131c\u0131 a\u00e7\u0131l\u0131yor...');
  console.log('');

  // Tarayıcıyı aç
  if (serverUrl && !launch.noBrowser) {
    openBrowser(serverUrl);
  }

  if (launch.roomId) {
    connectToRemoteServer(serverUrl, launch.roomId);
  }

  console.log(launch.roomId ? '  \u23F3 Destek oturumuna bağlanılıyor...' : '  \u23F3 Destek sayfasından oda bilgisi bekleniyor...');
  console.log('  (Kapatmak i\u00e7in Ctrl+C)');
  console.log('');
  });
}

localServer.on('error', async (err) => {
  if (err.code === 'EADDRINUSE') {
    if (listenRetries >= 2) {
      console.log(`  \u26A0 Port ${LOCAL_PORT} hala kullan\u0131mda. Eski ajan kapat\u0131lamad\u0131.`);
      process.exit(1);
    }
    listenRetries += 1;
    console.log(`  \u26A0 Port ${LOCAL_PORT} kullan\u0131mda. Eski ajan kapat\u0131l\u0131yor...`);
    await stopExistingAgent();
    setTimeout(startLocalServer, 700);
    return;
  }
  console.error('  \u26A0 Yerel sunucu hatas\u0131:', err.message);
});

startLocalServer();

function postLocalShutdown() {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: LOCAL_PORT,
      path: '/shutdown',
      method: 'POST',
      timeout: 500,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(true));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function killLocalPortProcess() {
  if (os.platform() === 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    exec(`pids=$(lsof -ti tcp:${LOCAL_PORT}); if [ -n "$pids" ]; then kill $pids; fi`, (err) => {
      resolve(!err);
    });
  });
}

async function stopExistingAgent() {
  const stopped = await postLocalShutdown();
  if (stopped) return true;
  return killLocalPortProcess();
}

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
function cleanup(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n  \uD83D\uDC4B Ajan kapat\u0131l\u0131yor...');
  remoteInput.destroy();
  if (remoteSocket) remoteSocket.disconnect();
  localServer.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));
process.on('SIGHUP', () => cleanup(0));
}
