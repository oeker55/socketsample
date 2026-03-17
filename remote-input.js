// remote-input.js — Windows'ta fare/klavye simülasyonu (PowerShell + user32.dll)
// Sunucu yayıncının makinesinde çalıştığında uzaktan kontrol sağlar.

const { spawn } = require('child_process');
const os = require('os');

// Mouse event flags
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const MOUSEEVENTF_WHEEL = 0x0800;
const KEYEVENTF_KEYUP = 0x0002;

class RemoteInput {
  constructor() {
    this.process = null;
    this.ready = false;
    this.enabled = false;
    this.screenWidth = 1920;
    this.screenHeight = 1080;
    this._cmdQueue = [];
    this._initDone = false;
    // Çoklu monitör desteği
    this.monitors = [];       // [{ x, y, w, h, primary }]
    this.activeMonitor = null; // Aktif monitör { x, y, w, h }
  }

  init() {
    if (os.platform() !== 'win32') {
      console.log('  ⚠ Uzaktan kontrol: sadece Windows desteklenir (atlanıyor)');
      return;
    }

    try {
      this.process = spawn('powershell.exe', [
        '-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command', '-'
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (err) {
      console.log('  ⚠ Uzaktan kontrol: PowerShell başlatılamadı:', err.message);
      return;
    }

    this.process.on('error', (err) => {
      console.log('  ⚠ PowerShell hata:', err.message);
      this.ready = false;
      this.enabled = false;
    });

    this.process.on('close', (code) => {
      console.log('  ⚠ PowerShell kapandı (kod:', code, ')');
      this.ready = false;
      this.enabled = false;
      this.process = null;
    });

    // stderr'den hata logla
    this.process.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) console.log('  ⚠ PowerShell stderr:', msg);
    });

    let outputBuf = '';
    this.process.stdout.on('data', (chunk) => {
      outputBuf += chunk.toString();
      const lines = outputBuf.split('\n');
      outputBuf = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('READY:')) {
          const parts = trimmed.slice(6).split(',').map(Number);
          if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) {
            this.screenWidth = parts[0];
            this.screenHeight = parts[1];
            this.ready = true;
            this.enabled = true;
            this._initDone = true;
            console.log(`  ✅ Uzaktan kontrol hazır (birincil: ${parts[0]}x${parts[1]})`);
            // Kuyrukta bekleyen komutları gönder
            for (const cmd of this._cmdQueue) this._writeRaw(cmd);
            this._cmdQueue = [];
          }
        }
        if (trimmed.startsWith('MON:')) {
          // MON:x,y,w,h,isPrimary
          const p = trimmed.slice(4).split(',').map(Number);
          if (p.length === 5) {
            this.monitors.push({ x: p[0], y: p[1], w: p[2], h: p[3], primary: !!p[4] });
            console.log(`  📺 Monitör: ${p[2]}x${p[3]} konum(${p[0]},${p[1]})${p[4] ? ' [birincil]' : ''}`);
          }
        }
      }
    });

    // Tek satırlık Add-Type — here-string kullanmıyoruz, pipe uyumlu
    const memberDef = [
      '[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
      '[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, IntPtr dwExtraInfo);',
      '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);',
      '[DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);',
    ].join(' ');

    // PowerShell'e tek satırlık komutlar gönder
    this._writeRaw(`Add-Type -MemberDefinition '${memberDef}' -Name NInput -Namespace Win32 -PassThru | Out-Null`);
    // Monitörleri numarala
    this._writeRaw(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { $b = $_.Bounds; $p = if($_.Primary){1}else{0}; Write-Output "MON:$($b.X),$($b.Y),$($b.Width),$($b.Height),$p" }`);
    this._writeRaw('$w = [Win32.NInput]::GetSystemMetrics(0); $h = [Win32.NInput]::GetSystemMetrics(1); Write-Output "READY:$w,$h"');
  }

  // Paylaşılan monitörü çözünürlüğe göre eşle
  setActiveMonitorByResolution(width, height) {
    if (!width || !height || this.monitors.length === 0) return;
    // Tam eşleşme ara
    let match = this.monitors.find(m => m.w === width && m.h === height);
    if (!match) {
      // En yakın en-boy oranı eşleşmesi
      const targetAR = width / height;
      let bestDiff = Infinity;
      for (const m of this.monitors) {
        const diff = Math.abs((m.w / m.h) - targetAR);
        if (diff < bestDiff) {
          bestDiff = diff;
          match = m;
        }
      }
    }
    if (match) {
      this.activeMonitor = match;
      console.log(`  🎯 Aktif monitör: ${match.w}x${match.h} konum(${match.x},${match.y})`);
    }
  }

  getMonitors() {
    return this.monitors;
  }

  _writeRaw(cmd) {
    if (this.process && this.process.stdin && this.process.stdin.writable) {
      this.process.stdin.write(cmd + '\r\n');
    }
  }

  _write(cmd) {
    if (!this._initDone) {
      this._cmdQueue.push(cmd);
      return;
    }
    this._writeRaw(cmd);
  }

  moveMouse(nx, ny) {
    if (!this.ready) return;
    if (typeof nx !== 'number' || typeof ny !== 'number' || isNaN(nx) || isNaN(ny)) return;
    nx = Math.max(0, Math.min(1, nx));
    ny = Math.max(0, Math.min(1, ny));

    let x, y;
    if (this.activeMonitor) {
      // Aktif monitörün sanal masaüstü koordinatlarına eşle
      const m = this.activeMonitor;
      x = Math.round(m.x + nx * m.w);
      y = Math.round(m.y + ny * m.h);
    } else {
      // Geri dönüş: birincil ekran
      x = Math.round(nx * this.screenWidth);
      y = Math.round(ny * this.screenHeight);
    }
    this._write(`[Win32.NInput]::SetCursorPos(${x}, ${y})`);
  }

  _mouseEvent(flags, data) {
    if (!this.ready) return;
    flags = Math.round(flags);
    data = Math.round(data || 0);
    this._write(`[Win32.NInput]::mouse_event(${flags}, 0, 0, ${data}, [IntPtr]::Zero)`);
  }

  mouseDown(button) {
    const map = { left: MOUSEEVENTF_LEFTDOWN, right: MOUSEEVENTF_RIGHTDOWN, middle: MOUSEEVENTF_MIDDLEDOWN };
    this._mouseEvent(map[button] || MOUSEEVENTF_LEFTDOWN);
  }

  mouseUp(button) {
    const map = { left: MOUSEEVENTF_LEFTUP, right: MOUSEEVENTF_RIGHTUP, middle: MOUSEEVENTF_MIDDLEUP };
    this._mouseEvent(map[button] || MOUSEEVENTF_LEFTUP);
  }

  scroll(rawDelta) {
    if (typeof rawDelta !== 'number' || isNaN(rawDelta)) return;
    const amount = -Math.sign(rawDelta) * 120;
    this._mouseEvent(MOUSEEVENTF_WHEEL, amount);
  }

  keyDown(vk) {
    if (!this.ready) return;
    if (typeof vk !== 'number' || !Number.isInteger(vk) || vk < 0 || vk > 255) return;
    this._write(`[Win32.NInput]::keybd_event(${vk}, 0, 0, [IntPtr]::Zero)`);
  }

  keyUp(vk) {
    if (!this.ready) return;
    if (typeof vk !== 'number' || !Number.isInteger(vk) || vk < 0 || vk > 255) return;
    this._write(`[Win32.NInput]::keybd_event(${vk}, 0, ${KEYEVENTF_KEYUP}, [IntPtr]::Zero)`);
  }

  getScreenSize() {
    return { width: this.screenWidth, height: this.screenHeight };
  }

  destroy() {
    if (this.process) {
      try {
        this._writeRaw('exit');
        this.process.kill();
      } catch (e) {}
      this.process = null;
      this.ready = false;
      this.enabled = false;
    }
  }
}

module.exports = RemoteInput;
