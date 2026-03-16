// ——— Socket.IO Bağlantısı ———
const socket = io();

const ICE_SERVERS = {
  iceServers: window.APP_CONFIG?.iceServers || [
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
  // Yayıncıdan Offer geldi
  socket.on('offer', async (data) => {
    const { broadcasterId: bId, offer, viewerId } = data;
    // Sadece bana gönderilen offer'ı işle
    if (viewerId !== socket.id) return;

    broadcasterId = bId;
    remoteDescSet = false;
    pendingCandidates = [];

    peerConnection = new RTCPeerConnection(ICE_SERVERS);

    // ICE adayları yayıncıya gönder
    peerConnection.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('ice-candidate', { fromId: socket.id, targetId: broadcasterId, candidate: e.candidate });
      }
    };

    // Stream geldiğinde videoyu göster
    peerConnection.ontrack = (e) => {
      const videoEl = document.getElementById('remote-video');
      if (videoEl.srcObject) return;
      const stream = e.streams[0] || new MediaStream([e.track]);
      videoEl.srcObject = stream;

      document.getElementById('waiting-section').style.display = 'none';
      document.getElementById('video-section').style.display = 'block';

      videoEl.play()
        .then(() => {
          document.getElementById('unmute-overlay').style.display = 'none';
        })
        .catch(() => {
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
      for (const c of pendingCandidates) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(c));
      }
      pendingCandidates = [];

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('answer', { viewerId: socket.id, answer });
    } catch (err) {
      console.error('Offer işleme hatası:', err);
      showError('❌ Bağlantı sırasında hata oluştu.');
    }
  });

  // ICE Adayı geldi
  socket.on('ice-candidate', async (data) => {
    const { fromId, candidate, targetId } = data;
    // Sadece bana gönderilenleri işle
    if (targetId !== socket.id) return;
    if (!peerConnection) return;
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

  // Yayıncı yayını bitirdi
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

  // Odaya katıl ve yayıncıya bildir
  socket.on('connect', () => {
    socket.emit('join-room', roomId, 'viewer');
    setStatus('⏳ Yayıncı bağlanmayı bekliyor...');
    // Chat'i izleyici olarak başlat
    initChat(socket, false);
  });

  // Sayfa kapatılırken yayıncıya bildir
  window.addEventListener('beforeunload', () => {
    if (socket.connected) {
      socket.emit('viewer-left', { viewerId: socket.id });
    }
  });
}

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
