// Клиент ELM327 поверх транспорта { write(str), readUntilPrompt(ms), drain(), close() }.
import {
  ElmError, guardCheck, parseLines, checkErrors, messages, pidsFromMask, maskHasNext, decodePid,
  isCanProtocol,
} from './protocol.js';

export class ElmClient {
  constructor(transport, { timeoutMs = 5000, connectTimeoutMs = 25000, log = () => {} } = {}) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.log = log;
    this.isCan = false;
    this._chain = Promise.resolve();
    this._inFlight = false;
  }

  /** Строго по одному запросу. */
  _locked(fn) {
    const run = this._chain.then(fn, fn);
    this._chain = run.catch(() => {});
    return run;
  }

  async _exchange(command, timeout) {
    if (this._inFlight) {
      await this.transport.drain();
      this._inFlight = false;
    }
    this._inFlight = true;
    this.log('→', command);
    await this.transport.write(command + '\r');
    let raw;
    try {
      raw = await this.transport.readUntilPrompt(timeout);
    } catch (e) {
      this.log('✖', 'нет ответа (' + (e.message || e) + ')');
      throw new ElmError('TIMEOUT', 'Адаптер не ответил вовремя на ' + command);
    }
    this._inFlight = false;
    const lines = parseLines(raw, command);
    this.log('←', lines.join(' | ') || '(пусто)');
    return lines;
  }

  /** Безопасная отправка: защита команд, проверка служебных ошибок. */
  send(command, { timeout = this.timeoutMs, allowProtocolSwitch = false, raw = false } = {}) {
    guardCheck(command, { allowProtocolSwitch });
    return this._locked(async () => {
      const lines = await this._exchange(command, timeout);
      if (!raw) checkErrors(lines);
      return lines;
    });
  }

  /**
   * Настройка адаптера и попытка подключения к блоку (ATSP0 + 0100).
   * Возвращает { elm: true, connected, reason?, lines }. Не бросает, если блок молчит: тогда можно запустить перебор протоколов.
   */
  async init() {
    await this.transport.drain();
    this._inFlight = false;
    const banner = await this._locked(() => this._exchange('ATZ', this.timeoutMs));
    if (!banner.some((l) => l.toUpperCase().includes('ELM'))) {
      throw new ElmError('NOT_ELM', 'Устройство не ответило как ELM327: ' + banner.join(', '));
    }
    for (const cmd of ['ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATAT1']) {
      try { await this.send(cmd); } catch (e) { if (e.kind !== 'UNKNOWN_COMMAND') throw e; }
    }
    await this.send('ATSP0');
    return this.tryConnect();
  }

  /** Запрос 0100 на выбранном протоколе. */
  async tryConnect(timeout = this.connectTimeoutMs) {
    try {
      const lines = await this.send('0100', { timeout });
      const ok = messages(lines).some((m) => m[0] === 0x41 && m[1] === 0x00);
      await this._detectProtocol();
      return { elm: true, connected: ok, reason: ok ? null : 'блок ответил, но не на запрос 0100: ' + lines.join(' | '), lines };
    } catch (e) {
      if (['NO_CONNECTION', 'BUS_ERROR', 'DATA_ERROR', 'TIMEOUT'].includes(e.kind)) {
        await this._detectProtocol().catch(() => {});
        return { elm: true, connected: false, reason: e.kind + ': ' + e.message, lines: [] };
      }
      throw e;
    }
  }

  async _detectProtocol() {
    const lines = await this.send('ATDPN');
    this.dpn = lines.join('').trim();
    this.isCan = isCanProtocol(this.dpn);
    return this.dpn;
  }

  async readPid(pid) {
    return decodePid(await this.send('01' + pid.hex), pid);
  }

  async readSupportedPids() {
    const all = new Set();
    for (let base = 0; base <= 0xc0; base += 0x20) {
      const lines = await this.send('01' + base.toString(16).toUpperCase().padStart(2, '0'));
      const msg = messages(lines).find((m) => m.length >= 6 && m[0] === 0x41 && m[1] === base);
      if (!msg) return base > 0 ? all : null;
      const mask = msg.slice(2, 6);
      for (const x of pidsFromMask(base, mask)) all.add(x);
      if (!maskHasNext(mask)) break;
    }
    return all;
  }

  async readAdapterVoltage() {
    const lines = await this.send('ATRV');
    for (const l of lines) {
      const m = /([0-9]+(?:\.[0-9]+)?)\s*V/i.exec(l);
      if (m) return parseFloat(m[1]);
    }
    return null;
  }

  close() { this.transport.close(); }
}
