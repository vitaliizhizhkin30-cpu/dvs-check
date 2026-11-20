// Web Bluetooth (Bluefy на iPhone, Chrome на Android). Только BLE: обычный Bluetooth classic на iPhone недоступен.
// Web Bluetooth требует заранее перечислить службы — берём популярные у ELM327-клонов.
export const KNOWN_SERVICES = [
  0xfff0, 0xffe0, 0x18f0, 0xfee0, 0xff00, 0xae00, 0xffd0, 0xfffe, 0xff10, 0xffb0,
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // ISSC
  '0000fff0-0000-1000-8000-00805f9b34fb',
];

export const bleSupported = () => typeof navigator !== 'undefined' && !!navigator.bluetooth;

export async function pickDevice() {
  return navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: KNOWN_SERVICES });
}

export class BleTransport {
  constructor(device) {
    this.device = device;
    this.buffer = '';
    this.waiter = null;
    this.closedError = null;
    this.rx = null;
    this.tx = null;
    this.info = {};
    this._onChange = (ev) => {
      const v = ev.target.value;
      this.buffer += new TextDecoder('ascii').decode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      this._wake();
    };
    this._onDisc = () => {
      this.closedError = new Error('Bluetooth-соединение потеряно');
      this._wake();
    };
  }

  _wake() { const w = this.waiter; this.waiter = null; if (w) w(); }

  async open() {
    this.device.addEventListener('gattserverdisconnected', this._onDisc);
    const server = await this.device.gatt.connect();
    const services = await server.getPrimaryServices();
    const seen = [];
    for (const s of services) {
      if (/^0000180[01]-/.test(s.uuid)) continue; // GAP/GATT
      const chars = await s.getCharacteristics();
      seen.push(s.uuid + ' [' + chars.map((c) => c.uuid.slice(0, 8) + ':' + Object.keys(c.properties).filter((k) => c.properties[k]).join('+')).join(', ') + ']');
      const rx = chars.find((c) => c.properties.notify || c.properties.indicate);
      const tx = chars.find((c) => c.properties.write || c.properties.writeWithoutResponse);
      if (rx && tx) { this.rx = rx; this.tx = tx; this.info.service = s.uuid; break; }
    }
    this.info.services = seen;
    if (!this.rx || !this.tx) throw new Error('Не найдена пара характеристик приём/передача (это не ELM327 с BLE?). Службы: ' + seen.join('; '));
    await this.rx.startNotifications();
    this.rx.addEventListener('characteristicvaluechanged', this._onChange);
  }

  async write(text) {
    if (this.closedError) throw this.closedError;
    const bytes = new TextEncoder().encode(text);
    for (let i = 0; i < bytes.length; i += 20) {
      const part = bytes.slice(i, i + 20);
      if (this.tx.properties.writeWithoutResponse && !this.tx.properties.write) await this.tx.writeValueWithoutResponse(part);
      else await this.tx.writeValue(part);
    }
  }

  async readUntilPrompt(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.buffer.indexOf('>');
      if (i >= 0) {
        const out = this.buffer.slice(0, i + 1);
        this.buffer = this.buffer.slice(i + 1);
        return out;
      }
      if (this.closedError) throw this.closedError;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timeout');
      await new Promise((resolve) => {
        const t = setTimeout(() => { this.waiter = null; resolve(); }, left);
        this.waiter = () => { clearTimeout(t); resolve(); };
      });
    }
  }

  async drain() {
    this.buffer = '';
    for (;;) {
      const before = this.buffer.length;
      await new Promise((r) => setTimeout(r, 300));
      if (this.buffer.length === before) break;
      this.buffer = '';
    }
  }

  close() {
    try { this.rx?.removeEventListener('characteristicvaluechanged', this._onChange); } catch {}
    try { this.device.removeEventListener('gattserverdisconnected', this._onDisc); } catch {}
    try { if (this.device.gatt.connected) this.device.gatt.disconnect(); } catch {}
  }
}
