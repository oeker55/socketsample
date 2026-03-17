// ——— Yerel Ajan Algılama ———
const AGENT_LOCAL_URL = 'http://127.0.0.1:9876';
let agentAvailable = false;

async function checkLocalAgent() {
  try {
    const res = await fetch(AGENT_LOCAL_URL + '/status', { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      agentAvailable = true;
      const data = await res.json();
      console.log('🤖 Yerel ajan algılandı:', data);
      updateAgentStatus(true, data.connected);
      return data;
    }
  } catch (e) { /* ajan çalışmıyor */ }
  agentAvailable = false;
  updateAgentStatus(false, false);
  return null;
}

async function connectAgentToRoom(roomId) {
  if (!agentAvailable) return;
  try {
    await fetch(AGENT_LOCAL_URL + '/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverUrl: window.location.origin, roomId })
    });
    console.log('🤖 Ajan odaya bağlandı:', roomId);
    updateAgentStatus(true, true);
  } catch (e) {
    console.warn('🤖 Ajan bağlantı hatası:', e);
  }
}

async function findMonitorIndex(width, height) {
  if (!agentAvailable) return undefined;
  try {
    const res = await fetch(AGENT_LOCAL_URL + '/status', { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return undefined;
    const status = await res.json();
    const monitors = status.monitors || [];
    // 1. Tam eşleşme
    let idx = monitors.findIndex(m => m.w === width && m.h === height);
    if (idx === -1) {
      // 2. %5 toleransla eşleşme
      idx = monitors.findIndex(m => {
        const wR = Math.abs(m.w - width) / Math.max(m.w, width);
        const hR = Math.abs(m.h - height) / Math.max(m.h, height);
        return wR < 0.05 && hR < 0.05;
      });
    }
    if (idx === -1) {
      // 3. En yakın piksel alanı
      const targetArea = width * height;
      let bestDiff = Infinity;
      monitors.forEach((m, i) => {
        const diff = Math.abs((m.w * m.h) - targetArea);
        if (diff < bestDiff) { bestDiff = diff; idx = i; }
      });
    }
    return idx >= 0 ? idx : undefined;
  } catch (e) { return undefined; }
}

async function sendMonitorInfo(width, height) {
  const monitorIndex = await findMonitorIndex(width, height);
  socket.emit('set-active-monitor', { width, height, monitorIndex });
  // Ajana da doğrudan bildir
  if (agentAvailable) {
    try {
      await fetch(AGENT_LOCAL_URL + '/set-monitor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ width, height, monitorIndex })
      });
    } catch (e) { /* sessiz */ }
  }
}

function updateAgentStatus(detected, connected) {
  const el = document.getElementById('agent-status');
  if (!el) return;
  // Ajan durumu sadece kontrol aktif veya talep edildiğinde gösterilir
  if (!detected || !controlViewerId) {
    el.style.display = 'none';
  } else {
    el.style.display = 'block';
    el.textContent = connected ? '🤖 Uzaktan kontrol ajanı bağlı' : '🤖 Ajan algılandı, bağlanıyor...';
    el.className = 'agent-status ' + (connected ? 'agent-connected' : 'agent-detected');
  }
}

// Ajan kontrolü sessizce yapılır, UI göstermez (sadece iç durum güncellenir)
async function silentAgentCheck() {
  try {
    const res = await fetch(AGENT_LOCAL_URL + '/status', { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      agentAvailable = true;
      return;
    }
  } catch (e) { /* ajan çalışmıyor */ }
  agentAvailable = false;
}

// Periyodik kontrol — sessiz (UI göstermez)
setInterval(silentAgentCheck, 5000);
silentAgentCheck();

// ——— Socket.IO Bağlantısı ———
const socket = io();
const myId = crypto.randomUUID();

const ICE_SERVERS = {
  iceServers: window.APP_CONFIG?.iceServers || [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

let localStream = null;
let peerConnections = {}; // viewerId -> RTCPeerConnection
let pendingCandidatesMap = {}; // viewerId -> [] (answer gelmeden önce ICE tamponu)
let remoteDescSetMap = {}; // viewerId -> bool
let viewerCount = 0;
let currentRoomId = null;

function ensureMediaDevices(featureName) {
  if (!window.isSecureContext) {
    throw new Error(`${featureName} için HTTPS gerekir. IP adresiyle HTTP üzerinden açıldığında tarayıcı bu özelliği kapatır.`);
  }

  if (!navigator.mediaDevices) {
    throw new Error('Tarayıcı medya aygıtlarına erişim vermedi. Sayfayı HTTPS üzerinden açın veya desteklenen bir masaustu tarayıcı kullanın.');
  }

  return navigator.mediaDevices;
}

function generateRoomId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

// ——— Socket.IO Olaylarını Kur ———
function setupSocketEvents() {
  // İzleyiciden answer geldi
  socket.on('answer', async (data) => {
    const { viewerId, answer } = data;
    const pc = peerConnections[viewerId];
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      remoteDescSetMap[viewerId] = true;
      for (const c of (pendingCandidatesMap[viewerId] || [])) {
        await pc.addIceCandidate(new RTCIceCandidate(c));
      }
      pendingCandidatesMap[viewerId] = [];
    } catch (err) {
      console.error('Answer işleme hatası:', err);
    }
  });

  // ICE adayı geldi
  socket.on('ice-candidate', async (data) => {
    const { fromId, candidate, targetId } = data;
    const pc = peerConnections[fromId];
    if (!pc) return;
    if (!remoteDescSetMap[fromId]) {
      if (!pendingCandidatesMap[fromId]) pendingCandidatesMap[fromId] = [];
      pendingCandidatesMap[fromId].push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('ICE aday hatası:', err);
    }
  });

  // İzleyici katıldı
  socket.on('viewer-joined', async (data) => {
    const { viewerId } = data;
    await handleNewViewer(viewerId);
  });

  // İzleyici ayrıldı
  socket.on('viewer-left', (data) => {
    const { viewerId } = data;
    if (peerConnections[viewerId]) {
      peerConnections[viewerId].close();
      delete peerConnections[viewerId];
      delete pendingCandidatesMap[viewerId];
      delete remoteDescSetMap[viewerId];
      viewerCount = Math.max(0, viewerCount - 1);
      document.getElementById('viewer-count').textContent = viewerCount;
    }
    // Kontrol oturumunu temizle
    if (viewerId === controlViewerId) {
      controlViewerId = null;
      document.getElementById('control-active-bar').style.display = 'none';
    }
    if (viewerId === pendingRequestViewerId) {
      pendingRequestViewerId = null;
      document.getElementById('control-notification').style.display = 'none';
    }
  });
}

setupSocketEvents();

// ——— Yeni izleyici için peer connection oluştur ———
async function handleNewViewer(viewerId) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  peerConnections[viewerId] = pc;
  pendingCandidatesMap[viewerId] = [];
  remoteDescSetMap[viewerId] = false;

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('ice-candidate', { fromId: socket.id, targetId: viewerId, candidate: e.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('Bağlantı durumu (' + viewerId + '):', pc.connectionState);
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { broadcasterId: socket.id, viewerId, offer });
  } catch (err) {
    console.error('Offer oluşturma hatası:', err);
  }

  viewerCount++;
  document.getElementById('viewer-count').textContent = viewerCount;
}

// ——— Stream başlatıcı yardımcı ———
async function startStream(stream) {
  localStream = stream;
  document.getElementById('local-video').srcObject = stream;
  document.getElementById('setup-section').style.display = 'none';
  document.getElementById('stream-section').style.display = 'block';

  const roomId = generateRoomId();
  currentRoomId = roomId;
  socket.emit('join-room', roomId, 'broadcaster');

  const link = `${window.location.origin}/viewer.html?room=${roomId}`;
  document.getElementById('share-link').value = link;
  // Chat'i yayıncı olarak başlat
  initChat(socket, true);

  // Ekran paylaşımı kullanıcı kendisi durdurursa
  stream.getVideoTracks()[0].onended = () => {
    document.getElementById('stop-btn').click();
  };
}

// ——— Aktif bağlantılardaki track'i değiştir ———
async function switchSource(newStream) {
  const newVideoTrack = newStream.getVideoTracks()[0];
  const newAudioTrack = newStream.getAudioTracks()[0];

  for (const pc of Object.values(peerConnections)) {
    const senders = pc.getSenders();
    const videoSender = senders.find((s) => s.track && s.track.kind === 'video');
    const audioSender = senders.find((s) => s.track && s.track.kind === 'audio');
    if (videoSender && newVideoTrack) await videoSender.replaceTrack(newVideoTrack);
    if (audioSender && newAudioTrack) await audioSender.replaceTrack(newAudioTrack);
  }

  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  localStream = newStream;
  document.getElementById('local-video').srcObject = newStream;

  // Kontrol aktifse yeni monitör bilgisini sunucuya ve ajana bildir
  if (controlViewerId) {
    const s = newVideoTrack?.getSettings();
    if (s) {
      await sendMonitorInfo(s.width, s.height);
    }
  }

  newStream.getVideoTracks()[0].onended = () => {
    document.getElementById('stop-btn').click();
  };
}

// ——— Kamera ile Başla ———
document.getElementById('start-camera-btn').addEventListener('click', async () => {
  try {
    const mediaDevices = ensureMediaDevices('Kamera/mikrofon erişimi');
    const stream = await mediaDevices.getUserMedia({ video: true, audio: true });
    await startStream(stream);
  } catch (err) {
    alert('❌ Kamera/mikrofon erişimi sağlanamadı:\n' + err.message);
  }
});

// ——— Ekran ile Başla ———
document.getElementById('start-screen-btn').addEventListener('click', async () => {
  try {
    const mediaDevices = ensureMediaDevices('Ekran paylaşımı');
    if (!mediaDevices.getDisplayMedia) {
      throw new Error('Bu tarayıcı ekran paylaşımını desteklemiyor. Chrome, Edge veya HTTPS üzerinden çalışan masaustu bir tarayıcı kullanın.');
    }
    const stream = await mediaDevices.getDisplayMedia({ video: true, audio: true });
    await startStream(stream);
  } catch (err) {
    if (err.name !== 'AbortError' && err.name !== 'NotAllowedError') {
      alert('❌ Ekran paylaşımı başlatmadı:\n' + err.message);
    }
  }
});

// ——— Kameraya Geç ———
document.getElementById('switch-camera-btn').addEventListener('click', async () => {
  try {
    const mediaDevices = ensureMediaDevices('Kamera/mikrofon erişimi');
    const stream = await mediaDevices.getUserMedia({ video: true, audio: true });
    await switchSource(stream);
  } catch (err) {
    alert('❌ Kamera erişimi sağlanamadı:\n' + err.message);
  }
});

// ——— Ekrana Geç ———
document.getElementById('switch-screen-btn').addEventListener('click', async () => {
  try {
    const mediaDevices = ensureMediaDevices('Ekran paylaşımı');
    if (!mediaDevices.getDisplayMedia) {
      throw new Error('Bu tarayıcı ekran paylaşımını desteklemiyor. Chrome, Edge veya HTTPS üzerinden çalışan masaustu bir tarayıcı kullanın.');
    }
    const stream = await mediaDevices.getDisplayMedia({ video: true, audio: true });
    await switchSource(stream);
  } catch (err) {
    if (err.name !== 'AbortError' && err.name !== 'NotAllowedError') {
      alert('❌ Ekran paylaşımı başlatmadı:\n' + err.message);
    }
  }
});

// ——— Linki Kopyala ———
document.getElementById('copy-btn').addEventListener('click', () => {
  const linkInput = document.getElementById('share-link');
  navigator.clipboard.writeText(linkInput.value).then(() => {
    const btn = document.getElementById('copy-btn');
    btn.textContent = '✅ Kopyalandı!';
    setTimeout(() => { btn.textContent = '📋 Kopyala'; }, 2500);
  });
});

// ——— Yayını Durdur ———
document.getElementById('stop-btn').addEventListener('click', () => {
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  Object.values(peerConnections).forEach((pc) => pc.close());
  peerConnections = {};
  pendingCandidatesMap = {};
  remoteDescSetMap = {};
  viewerCount = 0;
  document.getElementById('viewer-count').textContent = 0;

  // Kontrol oturumunu temizle
  if (controlViewerId) {
    socket.emit('control-revoke');
    controlViewerId = null;
    document.getElementById('control-active-bar').style.display = 'none';
  }
  pendingRequestViewerId = null;
  document.getElementById('control-notification').style.display = 'none';

  // Yayıncı ayrıldığını bildir
  if (socket.connected) {
    socket.emit('broadcaster-left');
  }

  document.getElementById('stream-section').style.display = 'none';
  document.getElementById('setup-section').style.display = 'block';
});

// ——— Uzaktan Kontrol (Yayıncı tarafı) ———
let controlViewerId = null;
let pendingRequestViewerId = null;

// İzleyiciden kontrol isteği geldi
socket.on('control-request', ({ viewerId, viewerName }) => {
  if (controlViewerId) return; // zaten biri kontrol ediyor
  pendingRequestViewerId = viewerId;
  document.getElementById('control-requester-name').textContent =
    (viewerName || 'Bir izleyici') + ' kontrol istiyor';
  document.getElementById('control-notification').style.display = 'block';
});

// Kabul
document.getElementById('control-accept-btn').addEventListener('click', async () => {
  if (!pendingRequestViewerId) return;

  // Uzaktan kontrol için tüm ekranın paylaşılması gerekir
  const videoTrack = localStream?.getVideoTracks()[0];
  const settings = videoTrack?.getSettings();
  const isFullScreen = settings?.displaySurface === 'monitor';

  if (!isFullScreen) {
    try {
      const mediaDevices = ensureMediaDevices('Ekran paylaşımı');
      const stream = await mediaDevices.getDisplayMedia({
        video: { displaySurface: 'monitor' },
        audio: true
      });
      await switchSource(stream);
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'NotAllowedError') {
        alert('⚠️ Uzaktan kontrol için tüm ekranın paylaşılması gerekir.\nLütfen "Tüm Ekran" seçeneğini seçin.');
        return;
      }
      console.warn('Tam ekran paylaşımına geçilemedi:', err.message);
    }
  }

  // Yerel ajanı kontrol isteği kabul edildiğinde bağla
  await checkLocalAgent();
  if (agentAvailable && currentRoomId) {
    await connectAgentToRoom(currentRoomId);
  }

  controlViewerId = pendingRequestViewerId;
  socket.emit('control-response', { viewerId: pendingRequestViewerId, granted: true });

  // Paylaşılan monitörün çözünürlüğünü sunucuya bildir
  const activeTrack = localStream?.getVideoTracks()[0];
  if (activeTrack) {
    const s = activeTrack.getSettings();
    await sendMonitorInfo(s.width, s.height);
  }

  pendingRequestViewerId = null;
  document.getElementById('control-notification').style.display = 'none';
  document.getElementById('control-active-bar').style.display = 'flex';
});

// Reddet
document.getElementById('control-deny-btn').addEventListener('click', () => {
  if (!pendingRequestViewerId) return;
  socket.emit('control-response', { viewerId: pendingRequestViewerId, granted: false });
  pendingRequestViewerId = null;
  document.getElementById('control-notification').style.display = 'none';
});

// Kontrolü geri al
document.getElementById('control-revoke-btn').addEventListener('click', () => {
  socket.emit('control-revoke');
  controlViewerId = null;
  document.getElementById('control-active-bar').style.display = 'none';
});

// İzleyici kontrolü bıraktı
socket.on('control-released', () => {
  controlViewerId = null;
  document.getElementById('control-active-bar').style.display = 'none';
});
