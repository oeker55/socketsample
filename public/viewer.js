const socket = io();

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

let peerConnection = null;
let broadcasterId = null;
let remoteDescSet = false;
let pendingCandidates = [];

const params = new URLSearchParams(window.location.search);
const roomId = params.get('room');

function setStatus(msg) {
  document.getElementById('status-msg').textContent = msg;
}

function showError(msg) {
  document.getElementById('loading-spinner').style.display = 'none';
  setStatus(msg);
}

// ——— Oda ID kontrolü ———
if (!roomId) {
  showError('❌ Geçersiz link! Oda ID\'si bulunamadı.');
} else {
  socket.emit('join-room', roomId, (response) => {
    if (response.error) {
      showError('❌ ' + response.error);
    } else {
      setStatus('⏳ Yayıncı bağlanmayı bekliyor...');
      // Chat'i izleyici olarak başlat
      initChat(socket, false);
    }
  });
}

// ——— Yayıncıdan Offer geldi ———
socket.on('offer', async ({ broadcasterId: bId, offer }) => {
  broadcasterId = bId;
  remoteDescSet = false;
  pendingCandidates = [];

  peerConnection = new RTCPeerConnection(ICE_SERVERS);

  // ICE adayları yayıncıya gönder
  peerConnection.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('ice-candidate', { targetId: broadcasterId, candidate: e.candidate });
    }
  };

  // Stream geldiğinde videoyu göster
  peerConnection.ontrack = (e) => {
    const videoEl = document.getElementById('remote-video');
    if (videoEl.srcObject) return; // zaten atandıysa tekrar atama
    const stream = e.streams[0] || new MediaStream([e.track]);
    videoEl.srcObject = stream;

    document.getElementById('waiting-section').style.display = 'none';
    document.getElementById('video-section').style.display = 'block';

    // Sesli autoplay'i dene
    videoEl.play()
      .then(() => {
        // Başarılı: overlay gizli kalır
        document.getElementById('unmute-overlay').style.display = 'none';
      })
      .catch(() => {
        // Tarayıcı engelledi: kullanıcıya buton göster
        document.getElementById('unmute-overlay').style.display = 'flex';
      });
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    if (state === 'disconnected' || state === 'failed') {
      document.getElementById('video-section').style.display = 'none';
      document.getElementById('waiting-section').style.display = 'block';
      document.getElementById('loading-spinner').style.display = 'none';
      setStatus('🔌 Yayın bağlantısı kesildi.');
    }
  };

  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    remoteDescSet = true;
    // Tampondaki ICE adaylarını işle
    for (const c of pendingCandidates) {
      await peerConnection.addIceCandidate(new RTCIceCandidate(c));
    }
    pendingCandidates = [];

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('answer', { broadcasterId, answer });
  } catch (err) {
    console.error('Offer işleme hatası:', err);
    showError('❌ Bağlantı sırasında hata oluştu.');
  }
});

// ——— ICE Adayı geldi ———
socket.on('ice-candidate', async ({ fromId, candidate }) => {
  if (!peerConnection) return;
  // Remote description henüz set edilmediyse tampona al
  if (!remoteDescSet) {
    pendingCandidates.push(candidate);
    return;
  }
  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error('ICE aday hatası:', err);
  }
});

// ——— Tam Ekran ———
const fullscreenBtn = document.getElementById('fullscreen-btn');
const fsExpand = document.getElementById('fs-icon-expand');
const fsShrink = document.getElementById('fs-icon-shrink');
const videoWrapper = document.getElementById('video-wrapper');

fullscreenBtn.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    (videoWrapper.requestFullscreen || videoWrapper.webkitRequestFullscreen).call(videoWrapper);
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  }
});

document.addEventListener('fullscreenchange', updateFsIcon);
document.addEventListener('webkitfullscreenchange', updateFsIcon);

function updateFsIcon() {
  const isFs = !!document.fullscreenElement;
  fsExpand.style.display = isFs ? 'none' : 'inline';
  fsShrink.style.display = isFs ? 'inline' : 'none';
}

// ——— Ses Aç butonu ———
document.getElementById('unmute-btn').addEventListener('click', () => {
  const videoEl = document.getElementById('remote-video');
  videoEl.muted = false;
  videoEl.play().then(() => {
    document.getElementById('unmute-overlay').style.display = 'none';
  });
});

// ——— Yayıncı yayını bitirdi ———
socket.on('broadcaster-left', () => {
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  document.getElementById('video-section').style.display = 'none';
  document.getElementById('waiting-section').style.display = 'block';
  document.getElementById('loading-spinner').style.display = 'none';
  setStatus('📴 Yayın sona erdi.');
});
