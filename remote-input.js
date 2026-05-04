// remote-input.js — Windows + macOS fare/klavye simülasyonu
// Windows: PowerShell + user32.dll
// macOS: osascript (JXA) + CoreGraphics — Python gerekmez

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

// macOS yardımcı JXA betiği — osascript ile çalışır, Python gerekmez
const MAC_HELPER_JXA = `ObjC.import('Cocoa');
ObjC.import('CoreGraphics');
ObjC.import('CoreFoundation');
ObjC.bindFunction('CGWarpMouseCursorPosition',['void',['{CGPoint=dd}']]);
ObjC.bindFunction('CGEventCreateMouseEvent',['void *',['void *','unsigned int','{CGPoint=dd}','unsigned int']]);
ObjC.bindFunction('CGEventCreateKeyboardEvent',['void *',['void *','unsigned short','bool']]);
ObjC.bindFunction('CGEventCreateScrollWheelEvent',['void *',['void *','unsigned int','unsigned int','int']]);
ObjC.bindFunction('CGEventPost',['void',['unsigned int','void *']]);
ObjC.bindFunction('CFRelease',['void',['void *']]);
var K={8:51,9:48,13:36,16:56,17:59,18:58,20:57,27:53,32:49,33:116,34:121,35:119,36:115,37:123,38:126,39:124,40:125,46:117,48:29,49:18,50:19,51:20,52:21,53:23,54:22,55:26,56:28,57:25,65:0,66:11,67:8,68:2,69:14,70:3,71:5,72:4,73:34,74:38,75:40,76:37,77:46,78:45,79:31,80:35,81:12,82:15,83:1,84:17,85:32,86:9,87:13,88:7,89:16,90:6,91:55,93:55,112:122,113:120,114:99,115:118,116:96,117:97,118:98,119:100,120:101,121:109,122:103,123:111,186:41,187:24,188:43,189:27,190:47,191:44,192:50,219:33,220:42,221:30,222:39};
var so=$.NSFileHandle.fileHandleWithStandardOutput;
var si=$.NSFileHandle.fileHandleWithStandardInput;
function w(s){so.writeData($.NSString.alloc.initWithUTF8String(s+'\\n').dataUsingEncoding($.NSUTF8StringEncoding));}
function post(ev){if(ev){$.CGEventPost(0,ev);$.CFRelease(ev);}}
function run(){
var screens=$.NSScreen.screens;
var ms=$.NSScreen.mainScreen;
var mf=ms.frame;
var pH=mf.size.height;
var mW=Math.round(mf.size.width);
var mH=Math.round(pH);
for(var i=0;i<screens.count;i++){
var s=screens.objectAtIndex(i);
var f=s.frame;
var gx=Math.round(f.origin.x);
var gy=Math.round(pH-f.origin.y-f.size.height);
var sw=Math.round(f.size.width);
var sh=Math.round(f.size.height);
var p=s.isEqual(ms)?1:0;
w('MON:'+gx+','+gy+','+sw+','+sh+','+p);
}
w('READY:'+mW+','+mH);
var buf='';
while(true){
var data=si.availableData;
if(data.length===0)break;
var chunk=$.NSString.alloc.initWithDataEncoding(data,$.NSUTF8StringEncoding).js;
buf+=chunk;
var lines=buf.split('\\n');
buf=lines.pop();
for(var li=0;li<lines.length;li++){
var line=lines[li].trim();
if(!line)continue;
try{
var d=JSON.parse(line);
var t=d.t;
if(t==='mm'){
$.CGWarpMouseCursorPosition({x:d.x,y:d.y});
}else if(t==='md'){
var mx=d.x,my=d.y,b=d.b||'left';
$.CGWarpMouseCursorPosition({x:mx,y:my});
if(b==='right')post($.CGEventCreateMouseEvent(null,3,{x:mx,y:my},1));
else if(b==='middle')post($.CGEventCreateMouseEvent(null,25,{x:mx,y:my},2));
else post($.CGEventCreateMouseEvent(null,1,{x:mx,y:my},0));
}else if(t==='mu'){
var mx=d.x,my=d.y,b=d.b||'left';
if(b==='right')post($.CGEventCreateMouseEvent(null,4,{x:mx,y:my},1));
else if(b==='middle')post($.CGEventCreateMouseEvent(null,26,{x:mx,y:my},2));
else post($.CGEventCreateMouseEvent(null,2,{x:mx,y:my},0));
}else if(t==='sc'){
var a=(d.dy||0)>0?-1:1;
post($.CGEventCreateScrollWheelEvent(null,1,1,a));
}else if(t==='kd'){
var mk=K[d.vk||0];
if(mk!==undefined)post($.CGEventCreateKeyboardEvent(null,mk,true));
}else if(t==='ku'){
var mk=K[d.vk||0];
if(mk!==undefined)post($.CGEventCreateKeyboardEvent(null,mk,false));
}
}catch(e){}
}
}
}`;

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
    this._pendingMonitor = null; // Monitörler yüklenene kadar bekleyen istek
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
            // Bekleyen monitör isteğini işle
            this._processPendingMonitor();
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
    this._macTmpFile = path.join(os.tmpdir(), 'remote-input-mac-' + process.pid + '.js');
    try {
      fs.writeFileSync(this._macTmpFile, MAC_HELPER_JXA, 'utf8');
    } catch (err) {
      console.log('  ⚠ macOS helper yazılamadı:', err.message);
      return;
    }

    try {
      this.process = spawn('/usr/bin/osascript', ['-l', 'JavaScript', this._macTmpFile], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }
      });
    } catch (err) {
      console.log('  ⚠ Uzaktan kontrol: osascript başlatılamadı:', err.message);
      this._cleanupMacTmp();
      return;
    }

    this.process.on('error', (err) => {
      console.log('  ⚠ osascript hata:', err.message);
      this.ready = false;
      this.enabled = false;
    });

    this.process.on('close', (code) => {
      console.log('  ⚠ osascript kapandı (kod:', code, ')');
      this.ready = false;
      this.enabled = false;
      this.process = null;
      this._cleanupMacTmp();
    });

    this.process.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) console.log('  ⚠ osascript stderr:', msg);
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
            console.log(`  ✅ Uzaktan kontrol hazır — macOS/JXA (birincil: ${parts[0]}x${parts[1]})`);
            console.log('  ℹ  macOS: Erişilebilirlik izni gerekebilir (Sistem Ayarları → Gizlilik → Erişilebilirlik)');
            this._processPendingMonitor();
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
    if (typeof index !== 'number' || index < 0) return;
    if (this.monitors.length === 0) {
      // Monitörler henüz yüklenmedi, kuyrukta beklet
      console.log(`  ⏳ Monitörler yükleniyor, indeks ${index} kuyruğa alındı`);
      this._pendingMonitor = { type: 'index', index };
      return;
    }
    if (index >= this.monitors.length) return;
    this.activeMonitor = this.monitors[index];
    const m = this.activeMonitor;
    console.log(`  🎯 Aktif monitör [${index}]: ${m.w}x${m.h} konum(${m.x},${m.y})`);
  }

  // Paylaşılan monitörü çözünürlüğe göre eşle
  setActiveMonitorByResolution(width, height) {
    if (!width || !height) return;
    if (this.monitors.length === 0) {
      // Monitörler henüz yüklenmedi, kuyrukta beklet
      console.log(`  ⏳ Monitörler yükleniyor, çözünürlük ${width}x${height} kuyruğa alındı`);
      this._pendingMonitor = { type: 'resolution', width, height };
      return;
    }
    console.log(`  🔍 Monitör eşleştirme: ${width}x${height}, mevcut monitörler:`, this.monitors.map(m => `${m.w}x${m.h}`));

    let match = null;

    // 1. Tam eşleşme ara
    match = this.monitors.find(m => m.w === width && m.h === height);

    // 2. %5 toleransla çözünürlük eşleşmesi (DPI farkları için)
    if (!match) {
      for (const m of this.monitors) {
        const wRatio = Math.abs(m.w - width) / Math.max(m.w, width);
        const hRatio = Math.abs(m.h - height) / Math.max(m.h, height);
        if (wRatio < 0.05 && hRatio < 0.05) {
          match = m;
          console.log(`  🔍 %5 tolerans eşleşmesi: ${m.w}x${m.h}`);
          break;
        }
      }
    }

    // 3. DPI ölçek faktörleriyle eşleşme (Chrome CSS piksel raporlayabilir)
    if (!match) {
      const scales = [1.25, 1.5, 1.75, 2.0, 2.5, 3.0];
      for (const s of scales) {
        const sw = Math.round(width * s);
        const sh = Math.round(height * s);
        match = this.monitors.find(m => Math.abs(m.w - sw) <= 2 && Math.abs(m.h - sh) <= 2);
        if (match) {
          console.log(`  🔍 DPI ölçek eşleşmesi x${s}: ${sw}x${sh} → ${match.w}x${match.h}`);
          break;
        }
      }
    }

    // 4. Ters DPI — monitör fiziksel piksel, Chrome daha büyük raporlayabilir
    if (!match) {
      const scales = [1.25, 1.5, 1.75, 2.0, 2.5, 3.0];
      for (const s of scales) {
        match = this.monitors.find(m => {
          const mw = Math.round(m.w / s);
          const mh = Math.round(m.h / s);
          return Math.abs(mw - width) <= 2 && Math.abs(mh - height) <= 2;
        });
        if (match) {
          console.log(`  🔍 Ters DPI eşleşmesi /${s}: ${match.w}x${match.h}`);
          break;
        }
      }
    }

    // 5. Benzersiz en-boy oranı eşleşmesi
    if (!match) {
      const targetRatio = width / height;
      const ratioMatches = this.monitors.filter(m => Math.abs((m.w / m.h) - targetRatio) < 0.02);
      if (ratioMatches.length === 1) {
        match = ratioMatches[0];
        console.log(`  🔍 Benzersiz en-boy oranı eşleşmesi: ${match.w}x${match.h}`);
      }
    }

    if (match) {
      this.activeMonitor = match;
      console.log(`  🎯 Aktif monitör: ${match.w}x${match.h} konum(${match.x},${match.y})`);
    } else {
      console.log(`  ⚠ Monitör eşleşmesi bulunamadı: ${width}x${height}`);
    }
  }

  getMonitors() {
    return this.monitors;
  }

  _processPendingMonitor() {
    if (!this._pendingMonitor || this.monitors.length === 0) return;
    const req = this._pendingMonitor;
    this._pendingMonitor = null;
    console.log('  🔄 Bekleyen monitör isteği işleniyor:', req);
    if (req.type === 'index') {
      this.setActiveMonitorByIndex(req.index);
    } else if (req.type === 'resolution') {
      this.setActiveMonitorByResolution(req.width, req.height);
    }
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
      // activeMonitor ayarlanmamış — birincil ekrana düşecek!
      if (!this._warnedNoMonitor) {
        console.log(`  ⚠ activeMonitor null! Birincil ekrana (${this.screenWidth}x${this.screenHeight}) düşülüyor. Monitors: ${this.monitors.length}`);
        this._warnedNoMonitor = true;
      }
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
    // PowerShell uint32 negatif değer kabul etmez, unsigned'a dönüştür
    if (data < 0) data = (data + 0x100000000) >>> 0;
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
