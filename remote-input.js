// remote-input.js — Windows + macOS fare/klavye simülasyonu
// Windows: PowerShell + user32.dll
// macOS: Python3 + CoreGraphics

const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Mouse event flags
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const MOUSEEVENTF_WHEEL = 0x0800;
const KEYEVENTF_KEYUP = 0x0002;

// macOS yardımcı Python betiği
const MAC_HELPER_SCRIPT = `import sys,json,ctypes,ctypes.util
try:
    CG=ctypes.cdll.LoadLibrary('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
    CF=ctypes.cdll.LoadLibrary('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
except:
    print("ERROR:CoreGraphics yuklenemedi",flush=True)
    sys.exit(1)
class P(ctypes.Structure):
    _fields_=[('x',ctypes.c_double),('y',ctypes.c_double)]
class S(ctypes.Structure):
    _fields_=[('width',ctypes.c_double),('height',ctypes.c_double)]
class R(ctypes.Structure):
    _fields_=[('origin',P),('size',S)]
CG.CGMainDisplayID.restype=ctypes.c_uint32
CG.CGDisplayBounds.restype=R
CG.CGDisplayBounds.argtypes=[ctypes.c_uint32]
CG.CGGetActiveDisplayList.argtypes=[ctypes.c_uint32,ctypes.POINTER(ctypes.c_uint32),ctypes.POINTER(ctypes.c_uint32)]
CG.CGWarpMouseCursorPosition.argtypes=[P]
CG.CGEventCreateMouseEvent.restype=ctypes.c_void_p
CG.CGEventCreateMouseEvent.argtypes=[ctypes.c_void_p,ctypes.c_uint32,P,ctypes.c_uint32]
CG.CGEventCreateKeyboardEvent.restype=ctypes.c_void_p
CG.CGEventCreateKeyboardEvent.argtypes=[ctypes.c_void_p,ctypes.c_uint16,ctypes.c_bool]
CG.CGEventCreateScrollWheelEvent.restype=ctypes.c_void_p
CG.CGEventCreateScrollWheelEvent.argtypes=[ctypes.c_void_p,ctypes.c_uint32,ctypes.c_uint32,ctypes.c_int32]
CG.CGEventPost.argtypes=[ctypes.c_uint32,ctypes.c_void_p]
CF.CFRelease.argtypes=[ctypes.c_void_p]
K={8:51,9:48,13:36,16:56,17:59,18:58,20:57,27:53,32:49,33:116,34:121,35:119,36:115,37:123,38:126,39:124,40:125,46:117,48:29,49:18,50:19,51:20,52:21,53:23,54:22,55:26,56:28,57:25,65:0,66:11,67:8,68:2,69:14,70:3,71:5,72:4,73:34,74:38,75:40,76:37,77:46,78:45,79:31,80:35,81:12,82:15,83:1,84:17,85:32,86:9,87:13,88:7,89:16,90:6,91:55,93:55,112:122,113:120,114:99,115:118,116:96,117:97,118:98,119:100,120:101,121:109,122:103,123:111,186:41,187:24,188:43,189:27,190:47,191:44,192:50,219:33,220:42,221:30,222:39}
def post(ev):
    if ev:
        CG.CGEventPost(0,ev)
        CF.CFRelease(ev)
n=16
c=ctypes.c_uint32()
ids=(ctypes.c_uint32*n)()
CG.CGGetActiveDisplayList(n,ids,ctypes.byref(c))
mid=CG.CGMainDisplayID()
for i in range(c.value):
    b=CG.CGDisplayBounds(ids[i])
    p=1 if ids[i]==mid else 0
    print(f"MON:{int(b.origin.x)},{int(b.origin.y)},{int(b.size.width)},{int(b.size.height)},{p}",flush=True)
mb=CG.CGDisplayBounds(mid)
print(f"READY:{int(mb.size.width)},{int(mb.size.height)}",flush=True)
for line in sys.stdin:
    line=line.strip()
    if not line:continue
    try:
        d=json.loads(line)
        t=d.get('t')
        if t=='mm':
            CG.CGWarpMouseCursorPosition(P(d['x'],d['y']))
        elif t=='md':
            x,y,b=d['x'],d['y'],d.get('b','left')
            CG.CGWarpMouseCursorPosition(P(x,y))
            if b=='right':post(CG.CGEventCreateMouseEvent(None,3,P(x,y),1))
            elif b=='middle':post(CG.CGEventCreateMouseEvent(None,25,P(x,y),2))
            else:post(CG.CGEventCreateMouseEvent(None,1,P(x,y),0))
        elif t=='mu':
            x,y,b=d['x'],d['y'],d.get('b','left')
            if b=='right':post(CG.CGEventCreateMouseEvent(None,4,P(x,y),1))
            elif b=='middle':post(CG.CGEventCreateMouseEvent(None,26,P(x,y),2))
            else:post(CG.CGEventCreateMouseEvent(None,2,P(x,y),0))
        elif t=='sc':
            a=-1 if d.get('dy',0)>0 else 1
            post(CG.CGEventCreateScrollWheelEvent(None,1,1,a))
        elif t=='kd':
            mk=K.get(d.get('vk',0),-1)
            if mk>=0:post(CG.CGEventCreateKeyboardEvent(None,mk,True))
        elif t=='ku':
            mk=K.get(d.get('vk',0),-1)
            if mk>=0:post(CG.CGEventCreateKeyboardEvent(None,mk,False))
    except:pass
`;

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
    this._platform = os.platform();
    this._macTmpFile = null;
    this._lastAbsX = 0;
    this._lastAbsY = 0;
  }

  init() {
    if (this._platform === 'darwin') {
      this._initMac();
      return;
    }
    if (this._platform !== 'win32') {
      console.log('  ⚠ Uzaktan kontrol: bu platform desteklenmiyor (' + this._platform + ')');
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
      '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
    ].join(' ');

    // PowerShell'e tek satırlık komutlar gönder
    this._writeRaw(`Add-Type -MemberDefinition '${memberDef}' -Name NInput -Namespace Win32 -PassThru | Out-Null`);
    // DPI farkındalığını etkinleştir — fiziksel piksel koordinatları kullanılsın
    this._writeRaw('[Win32.NInput]::SetProcessDPIAware() | Out-Null');
    // Monitörleri numarala (artık DPI-aware fiziksel koordinatlarla)
    this._writeRaw(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { $b = $_.Bounds; $p = if($_.Primary){1}else{0}; Write-Output "MON:$($b.X),$($b.Y),$($b.Width),$($b.Height),$p" }`);
    this._writeRaw('$w = [Win32.NInput]::GetSystemMetrics(0); $h = [Win32.NInput]::GetSystemMetrics(1); Write-Output "READY:$w,$h"');
  }

  // ——— macOS başlatma ———
  _initMac() {
    this._macTmpFile = path.join(os.tmpdir(), 'remote-input-mac-' + process.pid + '.py');
    try {
      fs.writeFileSync(this._macTmpFile, MAC_HELPER_SCRIPT, 'utf8');
    } catch (err) {
      console.log('  ⚠ macOS helper yazılamadı:', err.message);
      return;
    }

    try {
      this.process = spawn('python3', ['-u', this._macTmpFile], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }
      });
    } catch (err) {
      console.log('  ⚠ Uzaktan kontrol: Python3 başlatılamadı:', err.message);
      console.log('  ℹ  macOS için Python3 gereklidir. "xcode-select --install" ile yükleyebilirsiniz.');
      this._cleanupMacTmp();
      return;
    }

    this.process.on('error', (err) => {
      console.log('  ⚠ Python3 hata:', err.message);
      this.ready = false;
      this.enabled = false;
    });

    this.process.on('close', (code) => {
      console.log('  ⚠ Python3 kapandı (kod:', code, ')');
      this.ready = false;
      this.enabled = false;
      this.process = null;
      this._cleanupMacTmp();
    });

    this.process.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) console.log('  ⚠ Python3 stderr:', msg);
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
            console.log(`  ✅ Uzaktan kontrol hazır — macOS (birincil: ${parts[0]}x${parts[1]})`);
            console.log('  ℹ  macOS: Erişilebilirlik izni gerekebilir (Sistem Ayarları → Gizlilik → Erişilebilirlik)');
          }
        }
        if (trimmed.startsWith('MON:')) {
          const p = trimmed.slice(4).split(',').map(Number);
          if (p.length === 5) {
            this.monitors.push({ x: p[0], y: p[1], w: p[2], h: p[3], primary: !!p[4] });
            console.log(`  📺 Monitör: ${p[2]}x${p[3]} konum(${p[0]},${p[1]})${p[4] ? ' [birincil]' : ''}`);
          }
        }
        if (trimmed.startsWith('ERROR:')) {
          console.log('  ⚠ macOS helper hatası:', trimmed);
        }
      }
    });
  }

  _macCmd(obj) {
    if (!this.ready || !this.process || !this.process.stdin || !this.process.stdin.writable) return;
    this.process.stdin.write(JSON.stringify(obj) + '\n');
  }

  _cleanupMacTmp() {
    if (this._macTmpFile) {
      try { fs.unlinkSync(this._macTmpFile); } catch(e) {}
      this._macTmpFile = null;
    }
  }

  // Monitörü indeks ile ayarla (en güvenilir yöntem)
  setActiveMonitorByIndex(index) {
    if (typeof index !== 'number' || index < 0 || index >= this.monitors.length) return;
    this.activeMonitor = this.monitors[index];
    const m = this.activeMonitor;
    console.log(`  🎯 Aktif monitör [${index}]: ${m.w}x${m.h} konum(${m.x},${m.y})`);
  }

  // Paylaşılan monitörü çözünürlüğe göre eşle
  setActiveMonitorByResolution(width, height) {
    if (!width || !height || this.monitors.length === 0) return;
    // 1. Tam eşleşme ara
    let match = this.monitors.find(m => m.w === width && m.h === height);
    if (!match) {
      // 2. %5 toleransla çözünürlük eşleşmesi (DPI farkları için)
      for (const m of this.monitors) {
        const wRatio = Math.abs(m.w - width) / Math.max(m.w, width);
        const hRatio = Math.abs(m.h - height) / Math.max(m.h, height);
        if (wRatio < 0.05 && hRatio < 0.05) {
          match = m;
          break;
        }
      }
    }
    if (!match) {
      // 3. En yakın piksel alanı eşleşmesi (en-boy oranı yerine)
      const targetArea = width * height;
      let bestDiff = Infinity;
      for (const m of this.monitors) {
        const diff = Math.abs((m.w * m.h) - targetArea);
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
      const m = this.activeMonitor;
      x = Math.round(m.x + nx * m.w);
      y = Math.round(m.y + ny * m.h);
    } else {
      x = Math.round(nx * this.screenWidth);
      y = Math.round(ny * this.screenHeight);
    }
    this._lastAbsX = x;
    this._lastAbsY = y;

    if (this._platform === 'darwin') {
      this._macCmd({t:'mm', x, y});
    } else {
      this._write(`[Win32.NInput]::SetCursorPos(${x}, ${y})`);
    }
  }

  _mouseEvent(flags, data) {
    if (!this.ready) return;
    flags = Math.round(flags);
    data = Math.round(data || 0);
    this._write(`[Win32.NInput]::mouse_event(${flags}, 0, 0, ${data}, [IntPtr]::Zero)`);
  }

  mouseDown(button) {
    if (this._platform === 'darwin') {
      this._macCmd({t:'md', x: this._lastAbsX, y: this._lastAbsY, b: button || 'left'});
      return;
    }
    const map = { left: MOUSEEVENTF_LEFTDOWN, right: MOUSEEVENTF_RIGHTDOWN, middle: MOUSEEVENTF_MIDDLEDOWN };
    this._mouseEvent(map[button] || MOUSEEVENTF_LEFTDOWN);
  }

  mouseUp(button) {
    if (this._platform === 'darwin') {
      this._macCmd({t:'mu', x: this._lastAbsX, y: this._lastAbsY, b: button || 'left'});
      return;
    }
    const map = { left: MOUSEEVENTF_LEFTUP, right: MOUSEEVENTF_RIGHTUP, middle: MOUSEEVENTF_MIDDLEUP };
    this._mouseEvent(map[button] || MOUSEEVENTF_LEFTUP);
  }

  scroll(rawDelta) {
    if (typeof rawDelta !== 'number' || isNaN(rawDelta)) return;
    if (this._platform === 'darwin') {
      this._macCmd({t:'sc', dy: rawDelta});
      return;
    }
    const amount = -Math.sign(rawDelta) * 120;
    this._mouseEvent(MOUSEEVENTF_WHEEL, amount);
  }

  keyDown(vk) {
    if (!this.ready) return;
    if (typeof vk !== 'number' || !Number.isInteger(vk) || vk < 0 || vk > 255) return;
    if (this._platform === 'darwin') {
      this._macCmd({t:'kd', vk});
      return;
    }
    this._write(`[Win32.NInput]::keybd_event(${vk}, 0, 0, [IntPtr]::Zero)`);
  }

  keyUp(vk) {
    if (!this.ready) return;
    if (typeof vk !== 'number' || !Number.isInteger(vk) || vk < 0 || vk > 255) return;
    if (this._platform === 'darwin') {
      this._macCmd({t:'ku', vk});
      return;
    }
    this._write(`[Win32.NInput]::keybd_event(${vk}, 0, ${KEYEVENTF_KEYUP}, [IntPtr]::Zero)`);
  }

  getScreenSize() {
    return { width: this.screenWidth, height: this.screenHeight };
  }

  destroy() {
    if (this.process) {
      try {
        if (this._platform === 'darwin') {
          this.process.stdin.end();
        } else {
          this._writeRaw('exit');
        }
        this.process.kill();
      } catch (e) {}
      this.process = null;
      this.ready = false;
      this.enabled = false;
    }
    this._cleanupMacTmp();
  }
}

module.exports = RemoteInput;
