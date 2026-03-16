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

  // Yayıncı ayrıldığını bildir
  if (socket.connected) {
    socket.emit('broadcaster-left');
  }

  document.getElementById('stream-section').style.display = 'none';
  document.getElementById('setup-section').style.display = 'block';
});
