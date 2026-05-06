const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { Server } = require('socket.io');

const URL_PROTOCOL = 'royalstream-agent';

function loadLocalEnv() {
  const envFile = process.env.LOCAL_ENV_FILE || '.env';
  const envPath = path.resolve(__dirname, envFile);
  if (!envPath.startsWith(__dirname)) return;
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadLocalEnv();

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

app.use(express.json({ limit: '1mb' }));

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function getIceTransportPolicy() {
  const policy = String(process.env.ICE_TRANSPORT_POLICY || 'all').toLowerCase();
  return policy === 'relay' ? 'relay' : 'all';
}

function getTurnProvider() {
  const provider = String(process.env.TURN_PROVIDER || 'self').toLowerCase();
  return ['self', 'metered', 'both', 'none'].includes(provider) ? provider : 'self';
}

function buildIceServers() {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
  ];

  const provider = getTurnProvider();
  if (provider === 'metered' || provider === 'none') {
    return iceServers;
  }

  const turnUrls = splitCsv(process.env.TURN_URLS);
  if (turnUrls.length > 0) {
    // Kullanıcının kendi TURN sunucuları (env ile)
    iceServers.push({
      urls: turnUrls,
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
    if (!process.env.TURN_USERNAME || !process.env.TURN_CREDENTIAL) {
      console.warn('  WARN: TURN_URLS set but TURN_USERNAME/TURN_CREDENTIAL is missing.');
    }
  }

  return iceServers;
}

// Metered.ca API ile dinamik TURN credential alma
async function getMeteredTurnServers() {
  const provider = getTurnProvider();
  if (provider !== 'metered' && provider !== 'both') return null;
  const apiKey = process.env.METERED_API_KEY;
  const domain = process.env.METERED_DOMAIN;
  if (!apiKey || !domain) return null;
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
const supportSessions = new Map();

function sanitizeSessionId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
}

function createSupportSession(meta = {}) {
  const sessionId = sanitizeSessionId(meta.sessionId) || crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  const session = {
    sessionId,
    customerId: String(meta.customerId || '').slice(0, 120),
    customerName: String(meta.customerName || '').slice(0, 160),
    note: String(meta.note || '').slice(0, 500),
    status: 'waiting',
    createdAt: now,
    updatedAt: now,
  };
  supportSessions.set(sessionId, session);
  return session;
}

function getBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function publicSupportSession(req, session) {
  const baseUrl = getBaseUrl(req);
  return {
    ...session,
    supportUrl: `${baseUrl}/support.html?session=${encodeURIComponent(session.sessionId)}`,
    customerUrl: `${baseUrl}/customer.html?session=${encodeURIComponent(session.sessionId)}`,
    agentDeepLink: `${URL_PROTOCOL}://connect?server=${encodeURIComponent(baseUrl)}&room=${encodeURIComponent(session.sessionId)}`,
  };
}

function resolveChatRoom(socket, msg) {
  if (socket.data.roomId) return socket.data.roomId;
  const roomId = typeof msg?.roomId === 'string' ? msg.roomId.slice(0, 80) : '';
  if (roomId && socket.rooms.has(roomId)) return roomId;
  return null;
}

app.get('/', (req, res) => {
  res.redirect('/support.html');
});

app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/support/sessions', (req, res) => {
  const session = createSupportSession(req.body || {});
  res.status(201).json(publicSupportSession(req, session));
});

app.get('/api/support/sessions/:sessionId', (req, res) => {
  const session = supportSessions.get(req.params.sessionId);
  if (!session) {
    const created = createSupportSession({ sessionId: req.params.sessionId });
    return res.json(publicSupportSession(req, created));
  }
  res.json(publicSupportSession(req, session));
});

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
  res.setHeader('Cache-Control', 'no-store');
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
  res.send(`window.APP_CONFIG = ${JSON.stringify({
    iceServers: servers,
    iceTransportPolicy: getIceTransportPolicy(),
    turnProvider: getTurnProvider(),
  })};`);
});

app.get('/api/monitors', (req, res) => {
  res.json({ monitors: remoteInput.getMonitors() });
});

const ZIP_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = ZIP_CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(date.getFullYear(), 1980);
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function createZip(entries) {
  const fileParts = [];
  const centralParts = [];
  let offset = 0;
  const { dosTime, dosDate } = dosDateTime();

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '');
    const crc = crc32(data);
    const mode = entry.mode || 0o644;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    fileParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x031e, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((mode << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, name);
    offset += localHeader.length + name.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...fileParts, ...centralParts, end]);
}

function buildMacAgentAppZip(serverUrl, arch = 'arm64') {
  const normalizedArch = arch === 'x64' ? 'x64' : 'arm64';
  const agentFile = normalizedArch === 'x64' ? 'agent-mac' : 'agent-mac-arm';
  const agentPath = path.join(__dirname, 'public', agentFile);
  const iconPath = path.join(__dirname, 'public', 'agent-icon.icns');
  if (!fs.existsSync(agentPath)) return null;

  const appName = 'Royal Stream Agent.app';
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>Royal Stream Agent</string>
  <key>CFBundleIdentifier</key>
  <string>com.royalstream.agent</string>
  <key>CFBundleName</key>
  <string>Royal Stream Agent</string>
  <key>CFBundleDisplayName</key>
  <string>Royal Stream Agent</string>
  <key>CFBundleIconFile</key>
  <string>agent-icon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSUIElement</key>
  <true/>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>Royal Stream Agent Link</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>${URL_PROTOCOL}</string>
      </array>
    </dict>
  </array>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
</dict>
</plist>
`;
  const launcher = `#!/bin/bash
APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
INSTALL_DIR="$HOME/Applications"
INSTALL_APP="$INSTALL_DIR/Royal Stream Agent.app"
if [ "$APP_DIR" != "$INSTALL_APP" ]; then
  mkdir -p "$INSTALL_DIR"
  rm -rf "$INSTALL_APP"
  ditto "$APP_DIR" "$INSTALL_APP"
  xattr -cr "$INSTALL_APP" 2>/dev/null
  open "$INSTALL_APP" --args "$@"
  exit 0
fi
RESOURCE_DIR="$(cd "$(dirname "$0")/../Resources" && pwd)"
SERVER_URL="${serverUrl.replace(/"/g, '\\"')}"
AGENT="$RESOURCE_DIR/${agentFile}"
chmod +x "$AGENT" 2>/dev/null
AGENT_PARENT_PID=$$ "$AGENT" "$SERVER_URL" "$@" &
AGENT_PID=$!
cleanup() {
  if kill -0 "$AGENT_PID" 2>/dev/null; then
    kill "$AGENT_PID" 2>/dev/null
    wait "$AGENT_PID" 2>/dev/null
  fi
}
trap cleanup INT TERM HUP EXIT
wait "$AGENT_PID"
`;

  const entries = [
    { name: `${appName}/Contents/Info.plist`, data: plist, mode: 0o644 },
    { name: `${appName}/Contents/MacOS/Royal Stream Agent`, data: launcher, mode: 0o755 },
    { name: `${appName}/Contents/Resources/${agentFile}`, data: fs.readFileSync(agentPath), mode: 0o755 },
  ];
  if (fs.existsSync(iconPath)) {
    entries.push({ name: `${appName}/Contents/Resources/agent-icon.icns`, data: fs.readFileSync(iconPath), mode: 0o644 });
  }

  return createZip(entries);
}

// Ajan indirme endpoint'i
app.get('/download/agent.exe', (req, res) => {
  const agentPath = path.join(__dirname, 'public', 'agent.exe');
  if (!require('fs').existsSync(agentPath)) {
    return res.status(404).send('Agent dosyası bulunamadı');
  }
  res.download(agentPath, 'agent.exe');
});

app.get('/download/agent-windows.exe', (req, res) => {
  const agentPath = path.join(__dirname, 'public', 'agent.exe');
  if (!fs.existsSync(agentPath)) {
    return res.status(404).send('Agent dosyası bulunamadı');
  }
  res.download(agentPath, 'RoyalStreamAgentSetup.exe');
});

app.get('/download/agent-mac', (req, res) => {
  const agentPath = path.join(__dirname, 'public', 'agent-mac');
  if (!require('fs').existsSync(agentPath)) {
    return res.status(404).send('Agent dosyası bulunamadı');
  }
  res.download(agentPath, 'agent-mac');
});

app.get('/download/agent-mac-arm', (req, res) => {
  const agentPath = path.join(__dirname, 'public', 'agent-mac-arm');
  if (!require('fs').existsSync(agentPath)) {
    return res.status(404).send('Agent dosyası bulunamadı');
  }
  res.download(agentPath, 'agent-mac-arm');
});

app.get('/download/agent-mac-app.zip', (req, res) => {
  const serverUrl = `${req.protocol}://${req.get('host')}`;
  const zip = buildMacAgentAppZip(serverUrl, 'arm64');
  if (!zip) {
    return res.status(404).send('Mac agent dosyaları bulunamadı');
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="RoyalStreamAgent-mac.zip"');
  res.setHeader('Content-Length', zip.length);
  res.send(zip);
});

app.get('/download/agent-mac-intel-app.zip', (req, res) => {
  const serverUrl = `${req.protocol}://${req.get('host')}`;
  const zip = buildMacAgentAppZip(serverUrl, 'x64');
  if (!zip) {
    return res.status(404).send('Mac agent dosyaları bulunamadı');
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="RoyalStreamAgent-mac-intel.zip"');
  res.setHeader('Content-Length', zip.length);
  res.send(zip);
});
// macOS .command launcher — eski istemciler için tutulur
app.get('/download/agent-mac.command', (req, res) => {
  const serverUrl = `${req.protocol}://${req.get('host')}`;
  const script = `#!/bin/bash
# ====================================
# Royal Stream - Uzaktan Kontrol Ajan\u0131
# ====================================
cd "$(dirname "$0")"
SERVER="${serverUrl}"
ARCH="$(uname -m)"
if [ "$ARCH" = "arm64" ]; then
  BINARY="./agent-mac-arm"
  DOWNLOAD_PATH="/download/agent-mac-arm"
else
  BINARY="./agent-mac"
  DOWNLOAD_PATH="/download/agent-mac"
fi

echo ""
echo "  ========================================="
echo "  \ud83d\ude80  Royal Stream - macOS Agent Kurulumu"
echo "  ========================================="
echo ""

# Binary yoksa indir
if [ ! -f "$BINARY" ]; then
  echo "  \u2b07  Agent indiriliyor..."
  curl -fSL -o "$BINARY" "$SERVER$DOWNLOAD_PATH"
  if [ $? -ne 0 ]; then
    echo "  \u274c \u0130ndirme ba\u015far\u0131s\u0131z! L\u00fctfen internet ba\u011flant\u0131n\u0131z\u0131 kontrol edin."
    echo "  Kapatmak i\u00e7in bir tu\u015fa bas\u0131n..."
    read -n1
    exit 1
  fi
  echo "  \u2705 \u0130ndirme tamamland\u0131"
fi

# Quarantine kald\u0131r ve \u00e7al\u0131\u015ft\u0131rma izni ver
xattr -cr "$BINARY" 2>/dev/null
chmod +x "$BINARY"

echo "  \ud83d\ude80 Agent ba\u015flat\u0131l\u0131yor..."
echo ""
"$BINARY" "$SERVER"
`;
  res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="agent-mac.command"');
  res.send(script);
});
// ——— Socket.IO Sinyalizasyon ———
io.on('connection', (socket) => {
  // Odaya katıl
  socket.on('join-room', (roomId, role, ack) => {
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = role;
    socket.data.peerId = socket.id;

    if (role === 'viewer') {
      // Yayıncıya yeni izleyici bildirimi
      socket.to(roomId).emit('viewer-joined', { viewerId: socket.id });
    }

    if (role === 'broadcaster') {
      const room = io.sockets.adapter.rooms.get(roomId);
      if (room) {
        for (const sid of room) {
          if (sid === socket.id) continue;
          const s = io.sockets.sockets.get(sid);
          if (s && s.data.role === 'viewer') {
            socket.emit('viewer-joined', { viewerId: sid });
          }
        }
      }
    }

    if (role === 'agent') {
      console.log(`  🤖 Yerel ajan odaya katıldı: ${roomId}`);
    }

    if (typeof ack === 'function') ack({ ok: true, roomId, role });
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
    const roomId = resolveChatRoom(socket, msg);
    if (!roomId || !msg) return;
    socket.to(roomId).emit('chat-message', msg);
  });

  // Chat resim mesajı
  socket.on('chat-image', (msg) => {
    const roomId = resolveChatRoom(socket, msg);
    if (!roomId) return;
    if (!msg || typeof msg.imageData !== 'string') return;
    if (!msg.imageData.startsWith('data:image/')) return;
    // ~2 MB base64 sınırı
    if (msg.imageData.length > 3_000_000) return;
    socket.to(roomId).emit('chat-image', msg);
  });

  // Chat dosya mesajı (sunucuya yüklenen dosyanın URL'i)
  socket.on('chat-file', (msg) => {
    const roomId = resolveChatRoom(socket, msg);
    if (!roomId) return;
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
            if (data.type === 'mousemove' && s.volatile) {
              s.volatile.emit('remote-input-relay', data);
            } else {
              s.emit('remote-input-relay', data);
            }
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
  console.log('   TURN provider:', getTurnProvider());
  console.log(`\n✅ Sunucu çalışıyor: http://localhost:${PORT}`);
  console.log('   Sinyalizasyon: Socket.IO');
  console.log('   ICE sunucuları:', iceServers.map((s) => s.urls).flat().join(', '));
  console.log('   (İzleyici linki yayın başladıktan sonra otomatik oluşturulur)\n');
});
