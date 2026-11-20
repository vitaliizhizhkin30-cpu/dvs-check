// Протокол ELM327: разбор ответов, защита команд, PID, DTC, VIN, идентификация блока.
// Перенос из Kotlin-версии (GrantaOBD/protocol/*). Приложение только читает данные из блока.

export class ElmError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

// ---------- Защита команд (белый список) ----------
const SAFE_AT = new Set(['ATZ', 'ATE0', 'ATL0', 'ATS0', 'ATS1', 'ATH0', 'ATH1', 'ATAT1', 'ATSP0', 'ATDPN', 'ATRV', 'ATI', 'ATDP', 'ATKW']);
const READ_ONLY_OBD = /^(01[0-9A-F]{2}|02[0-9A-F]{4}|03|07|0A|09[0-9A-F]{2})$/;
const PROTOCOL_SWITCH = /^ATSP[1-9]$/; // выбор протокола — настройка адаптера, в блок ничего не пишет

/** Бросает ElmError(BLOCKED) до отправки в адаптер. Сброс кодов (04), запись, UDS, ATSH, ATPP и т.п. запрещены. */
export function guardCheck(command, { allowProtocolSwitch = false } = {}) {
  const cmd = command.trim().toUpperCase().replace(/ /g, '');
  let ok;
  if (cmd.startsWith('AT')) ok = SAFE_AT.has(cmd) || (allowProtocolSwitch && PROTOCOL_SWITCH.test(cmd));
  else ok = READ_ONLY_OBD.test(cmd);
  if (!ok) throw new ElmError('BLOCKED', `Команда запрещена защитой приложения: '${command}'`);
}

// ---------- Разбор ответов ----------
const FRAME_PREFIX = /^[0-9A-Fa-f]:/;
const LENGTH_LINE = /^[0-9A-Fa-f]{3}$/;
const NUMBERED_ERROR = /^ERR\d+$/;

/** Строки ответа без эха, '>', «SEARCHING...» и «BUS INIT: ...OK». */
export function parseLines(raw, command) {
  const echo = command.trim().replace(/ /g, '').toUpperCase();
  return raw.replace(/\r/g, '\n').split('\n')
    .map((s) => s.replace(/>/g, '').replace(/\u0000/g, '').trim())
    .filter((s) => s.length > 0)
    .filter((s) => s.replace(/ /g, '').toUpperCase() !== echo)
    .filter((s) => !s.startsWith('SEARCHING'))
    .filter((s) => !(s.toUpperCase().startsWith('BUS INIT') && !s.toUpperCase().includes('ERROR')));
}

/** Бросает ElmError на служебные сообщения об ошибках. «NO DATA» ошибкой не считается. */
export function checkErrors(lines) {
  for (const line of lines) {
    const u = line.toUpperCase().trim();
    let kind = null;
    if (u.includes('UNABLE TO CONNECT')) kind = 'NO_CONNECTION';
    else if (u.startsWith('BUS INIT') && u.includes('ERROR')) kind = 'NO_CONNECTION';
    else if (u.includes('CAN ERROR') || u.includes('BUS ERROR') || u.includes('FB ERROR') || u.includes('BUS BUSY') || u.includes('LV RESET') || NUMBERED_ERROR.test(u)) kind = 'BUS_ERROR';
    else if (u.includes('DATA ERROR') || u.includes('RX ERROR')) kind = 'DATA_ERROR';
    else if (u === 'STOPPED') kind = 'STOPPED';
    else if (u.includes('BUFFER FULL')) kind = 'BUFFER_FULL';
    else if (u === '?') kind = 'UNKNOWN_COMMAND';
    if (kind) throw new ElmError(kind, line);
  }
}

/** Сообщения-байты из строк: K-line/однострочный CAN — каждая строка; CAN multi-frame — склейка кадров «0:», «1:». */
export function messages(lines) {
  const out = [];
  let frame = null;
  let expected = null;
  let pendingLen = null;
  const flush = () => {
    if (frame) out.push(expected != null && expected < frame.length ? frame.slice(0, expected) : frame);
    frame = null;
    expected = null;
  };
  for (const raw of lines) {
    const isFrame = FRAME_PREFIX.test(raw);
    const hex = raw.replace(FRAME_PREFIX, '').replace(/ /g, '');
    if (hex.length === 0) continue;
    if (!/^[0-9A-Fa-f]+$/.test(hex)) continue;
    if (!isFrame && LENGTH_LINE.test(hex)) {
      flush();
      pendingLen = parseInt(hex, 16);
      continue;
    }
    if (hex.length % 2 !== 0) continue;
    const bytes = hex.match(/../g).map((h) => parseInt(h, 16));
    if (isFrame) {
      if (raw.startsWith('0:')) {
        flush();
        frame = bytes;
        expected = pendingLen;
        pendingLen = null;
      } else if (frame) frame.push(...bytes);
    } else {
      flush();
      pendingLen = null;
      out.push(bytes);
    }
  }
  flush();
  return out;
}

/** Ответ режима 01 корректен, если есть сообщение «41 <PID> …» с данными (отсекает искажённые BLE-кадры). */
export function isValidMode01Reply(lines, pid) {
  return messages(lines).some((m) => m.length >= 3 && m[0] === 0x41 && m[1] === pid);
}

// ---------- Маски PID ----------
export function pidsFromMask(base, mask) {
  const out = new Set();
  for (let i = 0; i < 32; i++) {
    const byte = mask[Math.floor(i / 8)];
    if (byte === undefined) break;
    if ((byte >> (7 - (i % 8))) & 1) out.add(base + i + 1);
  }
  return out;
}
export const maskHasNext = (mask) => ((mask[3] ?? 0) & 1) === 1;

// ---------- Коды ошибок ----------
const LETTERS = ['P', 'C', 'B', 'U'];
export function dtcFromBytes(a, b) {
  return LETTERS[(a >> 6) & 3] + ((a >> 4) & 3) + (a & 0xf).toString(16).toUpperCase() + b.toString(16).toUpperCase().padStart(2, '0');
}
/** CAN: после заголовка байт количества и 2*N байт; K-line: пары байт, 00 00 — заполнитель. */
export function dtcFromMessages(msgs, isCan, header = 0x43) {
  const result = new Set();
  for (const msg of msgs) {
    if (msg[0] !== header) continue;
    let data = msg.slice(1);
    if (isCan) data = data.slice(1, 1 + (data[0] ?? 0) * 2);
    for (let i = 0; i + 1 < data.length; i += 2) {
      if (data[i] === 0 && data[i + 1] === 0) continue;
      result.add(dtcFromBytes(data[i], data[i + 1]));
    }
  }
  return [...result];
}

// ---------- VIN и идентификация блока ----------
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
export function parseVin(msgs) {
  const parts = msgs.filter((m) => m.length >= 4 && m[0] === 0x49 && m[1] === 0x02);
  if (!parts.length) return null;
  const bytes = parts.sort((a, b) => a[2] - b[2]).flatMap((m) => m.slice(3));
  const text = bytes.filter((b) => b >= 0x20 && b <= 0x7e).map((b) => String.fromCharCode(b)).join('').toUpperCase();
  return VIN_RE.test(text) ? text : null;
}
export const asciiOf = (bytes) => bytes.filter((b) => b >= 0x20 && b <= 0x7e).map((b) => String.fromCharCode(b)).join('').trim();
export function mode09Payload(msgs, pid) {
  const parts = msgs.filter((m) => m.length >= 4 && m[0] === 0x49 && m[1] === pid);
  if (!parts.length) return null;
  return parts.sort((a, b) => a[2] - b[2]).flatMap((m) => m.slice(3));
}
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
export const calibrationIds = (data) => chunk(data, 16).map(asciiOf).filter((s) => s.length);
export const cvns = (data) => chunk(data, 4).filter((c) => c.length === 4 && c.some((b) => b)).map((c) => c.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(''));

// ---------- PID режима 01 ----------
const p = (code, name, unit, bytes, fn, extra = {}) => ({ code, hex: code.toString(16).toUpperCase().padStart(2, '0'), name, unit, bytes, decode: fn, ...extra });
export const PIDS = [
  p(0x04, 'Нагрузка двигателя', '%', 1, (d) => (d[0] * 100) / 255, { dash: true }),
  p(0x05, 'Температура ОЖ', '°C', 1, (d) => d[0] - 40, { dash: true }),
  p(0x06, 'Краткосрочная коррекция', '%', 1, (d) => ((d[0] - 128) * 100) / 128),
  p(0x07, 'Долгосрочная коррекция', '%', 1, (d) => ((d[0] - 128) * 100) / 128),
  p(0x0a, 'Давление топлива', 'кПа', 1, (d) => d[0] * 3),
  p(0x0b, 'Давление во впуске (MAP)', 'кПа', 1, (d) => d[0], { dash: true }),
  p(0x0c, 'Обороты', 'об/мин', 2, (d) => (d[0] * 256 + d[1]) / 4, { dash: true }),
  p(0x0d, 'Скорость', 'км/ч', 1, (d) => d[0], { dash: true }),
  p(0x0e, 'Угол опережения', '°', 1, (d) => d[0] / 2 - 64),
  p(0x0f, 'Температура впуска', '°C', 1, (d) => d[0] - 40, { dash: true }),
  p(0x10, 'Расход воздуха (MAF)', 'г/с', 2, (d) => (d[0] * 256 + d[1]) / 100, { dash: true }),
  p(0x11, 'Положение дросселя/педали', '%', 1, (d) => (d[0] * 100) / 255, { dash: true }),
  p(0x14, 'Лямбда до катализатора', 'В', 2, (d) => d[0] / 200),
  p(0x15, 'Лямбда после катализатора', 'В', 2, (d) => d[0] / 200),
  p(0x1f, 'Время работы двигателя', 'с', 2, (d) => d[0] * 256 + d[1]),
  p(0x21, 'Пробег с лампой Check Engine', 'км', 2, (d) => d[0] * 256 + d[1]),
  p(0x23, 'Давление в топливной рампе', 'кПа', 2, (d) => (d[0] * 256 + d[1]) * 10, { dash: true }),
  p(0x2c, 'Команда EGR', '%', 1, (d) => (d[0] * 100) / 255),
  p(0x2d, 'Ошибка EGR', '%', 1, (d) => ((d[0] - 128) * 100) / 128),
  p(0x31, 'Пробег после сброса кодов', 'км', 2, (d) => d[0] * 256 + d[1]),
  p(0x33, 'Атмосферное давление', 'кПа', 1, (d) => d[0]),
  p(0x42, 'Напряжение бортсети', 'В', 2, (d) => (d[0] * 256 + d[1]) / 1000, { dash: true }),
  p(0x46, 'Температура воздуха снаружи', '°C', 1, (d) => d[0] - 40),
  p(0x5c, 'Температура масла', '°C', 1, (d) => d[0] - 40, { dash: true }),
  p(0x5e, 'Расход топлива', 'л/ч', 2, (d) => (d[0] * 256 + d[1]) / 20),
];
export const PID_BY_CODE = new Map(PIDS.map((x) => [x.code, x]));

/** Значение PID из ответа или null (нет сообщения 41 <PID> или мало байт). */
export function decodePid(lines, pid) {
  const msg = messages(lines).find((m) => m.length >= 2 && m[0] === 0x41 && m[1] === pid.code);
  if (!msg) return null;
  const data = msg.slice(2);
  return data.length < pid.bytes ? null : pid.decode(data);
}

/** Идентификатор блока из строки с заголовком («7E8 06 41 00…», K-line «48 6B 11 41 00…»). */
export function ecuId(line, isCan) {
  const t = line.trim().split(/\s+/).filter(Boolean);
  const i = t.findIndex((x) => x.toUpperCase() === '41');
  if (t.length < 3 || i < 1) return null;
  if (t[i + 1]?.toUpperCase() !== '00') return null;
  if (isCan) return t[0].length === 3 ? t[0].toUpperCase() : t.slice(0, 4).join(' ').toUpperCase();
  return t[2]?.toUpperCase() ?? null;
}

export function protocolName(atdpn) {
  const c = (atdpn ?? '').trim().replace(/^A/i, '')[0];
  return ({
    1: 'SAE J1850 PWM', 2: 'SAE J1850 VPW', 3: 'ISO 9141-2 (K-line)', 4: 'KWP2000 (5 бод, K-line)',
    5: 'KWP2000 (быстрая инициализация, K-line)', 6: 'CAN 11 бит 500 кбит/с', 7: 'CAN 29 бит 500 кбит/с',
    8: 'CAN 11 бит 250 кбит/с', 9: 'CAN 29 бит 250 кбит/с',
  })[c] ?? 'не определён';
}
export function isCanProtocol(atdpn) {
  const n = parseInt(((atdpn ?? '').trim().replace(/^A/i, ''))[0], 16);
  return Number.isInteger(n) && n >= 6 && n <= 9;
}
