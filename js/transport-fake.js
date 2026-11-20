// Эмулятор адаптера ELM327 для тестов и демо-режима (без машины).
// Сценарии: 'can' — бензин на CAN (как Lada); 'kline' — дизель на K-line; 'needs3' — блок отвечает только после ATSP3;
// 'dead' — блок молчит ни на каком протоколе.
const hex = (s) => s.replace(/ /g, '');

export class FakeTransport {
  constructor(scenario = 'can', { vin = 'XTA219110K0310235', dtcs = [] } = {}) {
    this.scenario = scenario;
    this.vin = vin;
    this.dtcs = dtcs;
    this.protocol = '0'; // выбранный ATSP
    this.active = null; // реально установленный протокол
    this.buffer = '';
    this.sent = [];
    this.closed = false;
  }

  _bytesOfVin() { return [...this.vin].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(''); }

  _connects() {
    if (this.scenario === 'dead') return null;
    if (this.scenario === 'can') return ['0', '6'].includes(this.protocol) ? '6' : null;
    if (this.scenario === 'kline') return ['0', '3', '4', '5'].includes(this.protocol) ? '5' : null;
    if (this.scenario === 'needs3') return this.protocol === '3' ? '3' : null;
    return null;
  }

  _obd(cmd) {
    const p = this._connects();
    if (!p) return 'UNABLE TO CONNECT';
    this.active = p;
    const can = p === '6';
    const pre = !can && this.protocol === '0' && !this._inited ? 'BUS INIT: OK\r' : '';
    this._inited = true;
    const dtcBytes = this.dtcs.map((c) => {
      const L = 'PCBU'.indexOf(c[0]);
      const a = (L << 6) | (Number(c[1]) << 4) | parseInt(c[2], 16);
      return a.toString(16).padStart(2, '0') + c.slice(3, 5).toLowerCase();
    });
    const table = {
      '0100': can ? '41 00 BE 1F B8 11' : '41 00 98 18 80 10',
      '0120': '41 20 80 00 00 00',
      '0101': can ? '41 01 00 07 65 40' : '41 01 00 04 00 00',
      '0104': '41 04 38',
      '0105': '41 05 7D',
      '010B': '41 0B 63',
      '010C': '41 0C 0F A0',
      '010D': '41 0D 00',
      '010F': '41 0F 41',
      '0110': '41 10 01 92',
      '0111': '41 11 10',
      '0123': '41 23 0B B8',
      '0103': '41 03 01 00', '0106': '41 06 80', '0107': '41 07 95', '010E': '41 0E 8D', '0113': '41 13 03',
      '0114': '41 14 7A 80', '0115': '41 15 BA FF', '011C': '41 1C 06', '0121': '41 21 00 00',
      '0900': '49 00 55 00 00 00',
    };
    const k = hex(cmd);
    if (k === '0902') {
      const v = this._bytesOfVin();
      if (can) return '014\r0:490201' + v.slice(0, 6) + '\r1:' + v.slice(6, 20) + '\r2:' + v.slice(20);
      return ['49 02 01 00 00 00 ' + v.slice(0, 2), '49 02 02 ' + v.slice(2, 10), '49 02 03 ' + v.slice(10, 18), '49 02 04 ' + v.slice(18, 26), '49 02 05 ' + v.slice(26)].join('\r');
    }
    if (k === '03') {
      const body = dtcBytes.length ? dtcBytes.join('') : '';
      if (can) return '43' + dtcBytes.length.toString(16).padStart(2, '0') + body;
      return dtcBytes.length ? dtcBytes.map((b) => '43 ' + b.slice(0, 2) + ' ' + b.slice(2)).join('\r') : '43 00 00 00 00 00 00';
    }
    if (k === '07') return can ? '4700' : 'NO DATA';
    if (k === '0A') return 'NO DATA';
    if (this.scenario === 'kline' && ['0904', '0906'].includes(k)) return 'NO DATA';
    if (table[k]) return pre + hex(table[k]).replace(/(..)/g, '$1 ').trim();
    return 'NO DATA';
  }

  _respond(raw) {
    const cmd = raw.trim().toUpperCase();
    if (cmd === 'ATZ') return 'ELM327 v1.5';
    if (cmd === 'ATI') return 'ELM327 v1.5';
    if (cmd === 'ATRV') return '12.6V';
    if (cmd === 'ATDPN') return this.active ? 'A' + this.active : 'A' + this.protocol;
    if (cmd === 'ATDP') return this.active ? 'AUTO, protocol ' + this.active : 'AUTO';
    if (/^ATSP[0-9A-C]$/.test(cmd)) { this.protocol = cmd[4]; this.active = null; this._inited = false; return 'OK'; }
    if (/^AT/.test(cmd)) return cmd === 'ATKW' ? 'KW1=08 KW2=08' : 'OK';
    return this._obd(cmd);
  }

  async write(text) {
    if (this.closed) throw new Error('closed');
    this.sent.push(text.trim());
    const out = this._respond(text);
    this.buffer += text.trim() + '\r' + out + '\r\r>';
  }

  async readUntilPrompt(ms) {
    const i = this.buffer.indexOf('>');
    if (i < 0) throw new Error('timeout');
    const out = this.buffer.slice(0, i + 1);
    this.buffer = this.buffer.slice(i + 1);
    return out;
  }

  async drain() { this.buffer = ''; }
  close() { this.closed = true; }
}
