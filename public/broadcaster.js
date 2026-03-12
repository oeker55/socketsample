const socket = io();

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

let localStream = null;
let peerConnections = {}; // viewerId -> RTCPeerConnection
let pendingCandidatesMap = {}; // viewerId -> [] (answer gelmeden önce ICE tamponu)
let remoteDescSetMap = {}; // viewerId -> bool
let viewerCount = 0;

// ——— Stream başlatıcı yardımcı ———
async function startStream(stream) {
  localStream = stream;
  document.getElementById('local-video').srcObject = stream;
  document.getElementById('setup-section').style.display = 'none';
  document.getElementById('stream-section').style.display = 'block';

  socket.emit('create-room', ({ roomId }) => {
    const link = `${window.location.origin}/viewer.html?room=${roomId}`;
    document.getElementById('share-link').value = link;
    // Chat'i yayıncı olarak başlat
    initChat(socket, true);
  });

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
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    await startStream(stream);
  } catch (err) {
    alert('❌ Kamera/mikrofon erişimi sağlanamadı:\n' + err.message);
  }
});

// ——— Ekran ile Başla ———
document.getElementById('start-screen-btn').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
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
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    await switchSource(stream);
  } catch (err) {
    alert('❌ Kamera erişimi sağlanamadı:\n' + err.message);
  }
});

// ——— Ekrana Geç ———
document.getElementById('switch-screen-btn').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
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
  socket.disconnect();

  document.getElementById('stream-section').style.display = 'none';
  document.getElementById('setup-section').style.display = 'block';
});

// ——— Yeni izleyici katıldı: Offer gönder ———
socket.on('viewer-joined', async (viewerId) => {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  peerConnections[viewerId] = pc;
  pendingCandidatesMap[viewerId] = [];
  remoteDescSetMap[viewerId] = false;

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('ice-candidate', { targetId: viewerId, candidate: e.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('Bağlantı durumu (' + viewerId + '):', pc.connectionState);
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { viewerId, offer });
  } catch (err) {
    console.error('Offer oluşturma hatası:', err);
  }

  viewerCount++;
  document.getElementById('viewer-count').textContent = viewerCount;
});

// ——— İzleyiciden Answer geldi ———
socket.on('answer', async ({ viewerId, answer }) => {
  const pc = peerConnections[viewerId];
  if (!pc) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
    remoteDescSetMap[viewerId] = true;
    // Tampondaki ICE adaylarını işle
    for (const c of (pendingCandidatesMap[viewerId] || [])) {
      await pc.addIceCandidate(new RTCIceCandidate(c));
    }
    pendingCandidatesMap[viewerId] = [];
  } catch (err) {
    console.error('Answer işleme hatası:', err);
  }
});

// ——— ICE Adayı geldi ———
socket.on('ice-candidate', async ({ fromId, candidate }) => {
  const pc = peerConnections[fromId];
  if (!pc) return;
  // Remote description henüz set edilmediyse tampona al
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

// ——— İzleyici ayrıldı ———
socket.on('viewer-left', (viewerId) => {
  if (peerConnections[viewerId]) {
    peerConnections[viewerId].close();
    delete peerConnections[viewerId];
    viewerCount = Math.max(0, viewerCount - 1);
    document.getElementById('viewer-count').textContent = viewerCount;
  }
});
