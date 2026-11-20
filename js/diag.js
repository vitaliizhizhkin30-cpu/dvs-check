// Полная диагностика «паспорт автомобиля»: адаптер, протокол (с перебором, если блок молчит), блоки, режим 09, коды, снимок PID.
import {
  messages, pidsFromMask, maskHasNext, dtcFromMessages, parseVin, mode09Payload, calibrationIds, cvns, asciiOf,
  ecuId, protocolName, isCanProtocol, isValidMode01Reply, PID_BY_CODE,
} from './protocol.js';

const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
// Порядок перебора: K-line (старые двигатели и дизели), затем J1850, затем CAN.
export const PROBE_ORDER = [3, 4, 5, 1, 2, 6, 7, 8, 9];

export async function runDiagnostics(client, { onProgress = () => {}, shouldCancel = () => false, probe = true, now = () => new Date() } = {}) {
  const started = now();
  const raw = {};
  const info = {};
  let failures = 0;
  const step = (text) => onProgress(text);

  const rec = async (cmd, opts) => {
    try {
      const lines = await client.send(cmd, { ...opts, raw: true });
      raw[cmd] = lines;
      failures = 0;
      return lines;
    } catch (e) {
      raw[cmd] = 'ОШИБКА ' + e.kind + ': ' + e.message;
      if (e.kind !== 'NO_DATA') failures++;
      if (e.kind === 'BLOCKED') throw e;
      return null;
    }
  };

  info['собрано'] = started.toISOString();
  step('Адаптер…');
  for (const c of ['ATI', 'ATRV']) await rec(c);

  // ---- подключение к блоку
  step('Подключение к блоку управления…');
  let conn = await client.tryConnect();
  const probeLog = [];
  info['автопоиск_протокола'] = conn.connected ? 'успешно' : 'блок не ответил: ' + (conn.reason ?? '');
  if (!conn.connected && probe) {
    for (const n of PROBE_ORDER) {
      if (shouldCancel()) { info['перебор_прерван'] = true; break; }
      step(`Перебор протоколов: ${n} (${protocolName(String(n))})…`);
      try {
        await client.send('ATSP' + n, { allowProtocolSwitch: true });
        const r = await client.tryConnect(20000);
        probeLog.push({ протокол: n, название: protocolName(String(n)), подключено: r.connected, причина: r.reason });
        if (r.connected) { conn = r; break; }
      } catch (e) {
        probeLog.push({ протокол: n, название: protocolName(String(n)), подключено: false, причина: e.kind + ': ' + e.message });
      }
    }
    if (!conn.connected) { try { await client.send('ATSP0'); } catch { /* не критично */ } }
    info['перебор_протоколов'] = probeLog;
  }
  info['подключено'] = conn.connected;
  const dpn = client.dpn ?? null;
  info['протокол_ATDPN'] = dpn;
  info['протокол'] = protocolName(dpn);
  info['CAN'] = client.isCan;
  await rec('ATDP');
  if (!client.isCan) await rec('ATKW'); // ключевые слова K-line (если адаптер знает команду)

  const out = { сводка: info, сырые_ответы: raw, снимок_режим01: {} };
  if (!conn.connected) return finish(out, started, now, 'Блок управления не ответил ни на одном протоколе. Для машин до ~2003 года (дизели — до ~2004) стандартный OBD-II может не поддерживаться.');

  // ---- маски режима 01
  step('Список поддерживаемых параметров…');
  const pids = new Set();
  for (let base = 0; base <= 0xc0; base += 0x20) {
    const lines = await rec('01' + hex2(base));
    if (!lines) break;
    const msg = messages(lines).find((m) => m.length >= 6 && m[0] === 0x41 && m[1] === base);
    if (!msg) break;
    const mask = msg.slice(2, 6);
    for (const x of pidsFromMask(base, mask)) pids.add(x);
    if (!maskHasNext(mask)) break;
  }
  info['режим01_поддерживается'] = [...pids].sort((a, b) => a - b).map(hex2);

  // ---- блоки, ответившие на 0100
  step('Поиск блоков…');
  const ecus = [];
  try {
    await client.send('ATS1'); await client.send('ATH1');
    const lines = await client.send('0100', { timeout: client.connectTimeoutMs });
    for (const l of lines) { const id = ecuId(l, client.isCan); if (id && !ecus.includes(id)) ecus.push(id); }
  } catch (e) { raw['scanEcus'] = 'ОШИБКА ' + e.kind + ': ' + e.message; }
  finally { for (const c of ['ATH0', 'ATS0']) { try { await client.send(c); } catch { /* ignore */ } } }
  info['блоки_ответили_на_0100'] = ecus;

  // ---- режим 09
  step('Идентификация (VIN, калибровка)…');
  const l00 = await rec('0900');
  const m09 = l00 && messages(l00).find((m) => m.length >= 6 && m[0] === 0x49 && m[1] === 0x00);
  const sup09 = m09 ? pidsFromMask(0, m09.slice(2, 6)) : new Set();
  info['режим09_поддерживается'] = [...sup09].sort((a, b) => a - b).map(hex2);
  const to09 = sup09.size ? [...sup09].filter((x) => x % 0x20 !== 0).sort((a, b) => a - b) : [0x02, 0x04, 0x06, 0x0a];
  for (const pid of to09) await rec('09' + hex2(pid));
  const msgs = (c) => messages(Array.isArray(raw[c]) ? raw[c] : []);
  info['VIN'] = parseVin(msgs('0902'));
  const cal = mode09Payload(msgs('0904'), 0x04);
  const cv = mode09Payload(msgs('0906'), 0x06);
  const nm = mode09Payload(msgs('090A'), 0x0a);
  info['CAL_ID'] = cal ? calibrationIds(cal) : [];
  info['CVN'] = cv ? cvns(cv) : [];
  info['имя_блока'] = nm ? asciiOf(nm) || null : null;

  // ---- лампа, коды
  step('Коды ошибок…');
  const l01 = await rec('0101');
  const m01 = l01 && messages(l01).find((m) => m.length >= 3 && m[0] === 0x41 && m[1] === 0x01);
  if (m01) { info['лампа_горит'] = (m01[2] & 0x80) !== 0; info['число_кодов'] = m01[2] & 0x7f; }
  for (const [cmd, header, label] of [['03', 0x43, 'коды_03'], ['07', 0x47, 'коды_07'], ['0A', 0x4a, 'коды_0A']]) {
    const lines = await rec(cmd);
    const ms = lines ? messages(lines) : [];
    info[label] = ms.some((m) => m[0] === header) ? dtcFromMessages(ms, client.isCan, header) : null;
  }

  // ---- сырой снимок режима 01: каждый ответ проверяется по префиксу «41 <PID>», искажённые запрашиваются повторно
  step('Снимок параметров…');
  const snap = {};
  const bad = [];
  for (const pid of [...pids].sort((a, b) => a - b)) {
    if (pid % 0x20 === 0) continue;
    if (shouldCancel()) { info['прервано'] = 'по просьбе пользователя'; break; }
    const cmd = '01' + hex2(pid);
    let lines = await rec(cmd);
    if (!lines) { if (failures >= 5) { info['прервано'] = 'серия ошибок связи'; break; } continue; }
    const noData = (l) => l.some((x) => /NO DATA/i.test(x)); // «нет данных» — не искажение
    for (let attempt = 0; attempt < 2 && !isValidMode01Reply(lines, pid) && !noData(lines) && failures < 5; attempt++) {
      lines = (await rec(cmd)) ?? lines;
    }
    snap[cmd] = lines;
    if (!isValidMode01Reply(lines, pid) && !noData(lines)) bad.push(cmd);
  }
  out.снимок_режим01 = snap;
  if (bad.length) info['снимок_искажённые_ответы'] = bad;

  // ---- расшифровка значений
  const decoded = {};
  for (const [cmd, lines] of Object.entries(snap)) {
    const pid = PID_BY_CODE.get(parseInt(cmd.slice(2), 16));
    if (!pid) continue;
    const msg = messages(lines).find((m) => m[0] === 0x41 && m[1] === pid.code);
    if (msg && msg.length - 2 >= pid.bytes) decoded[pid.name] = Math.round(pid.decode(msg.slice(2)) * 100) / 100 + ' ' + pid.unit;
  }
  info['значения_в_момент_снимка'] = decoded;
  return finish(out, started, now, null);
}

function finish(out, started, now, note) {
  out.сводка['длительность_с'] = Math.round((now() - started) / 1000);
  if (note) out.сводка['примечание'] = note;
  return out;
}

/** Короткая сводка для экрана. */
export function summarize(report) {
  const s = report.сводка;
  const lines = [];
  lines.push(`Подключение к блоку: ${s['подключено'] ? 'есть' : 'НЕТ'}`);
  lines.push(`Протокол: ${s['протокол']}${s['протокол_ATDPN'] ? ' (' + s['протокол_ATDPN'] + ')' : ''}`);
  if (s['перебор_протоколов']) {
    lines.push('Перебор протоколов: ' + s['перебор_протоколов'].map((p) => `${p['протокол']}${p['подключено'] ? '✓' : '✗'}`).join(' '));
  }
  if (s['подключено']) {
    lines.push(`VIN: ${s['VIN'] ?? 'не получен'}`);
    lines.push(`CAL ID: ${(s['CAL_ID'] || []).join(', ') || 'нет'}`);
    lines.push(`Параметров режима 01: ${(s['режим01_поддерживается'] || []).filter((h) => parseInt(h, 16) % 32 !== 0).length}`);
    lines.push(`Лампа Check Engine: ${s['лампа_горит'] === undefined ? 'неизвестно' : s['лампа_горит'] ? 'горит' : 'не горит'}`);
    lines.push(`Активные коды: ${s['коды_03'] == null ? 'блок не ответил' : s['коды_03'].join(', ') || 'нет'}`);
    lines.push(`Ожидающие коды: ${s['коды_07'] == null ? 'нет данных' : s['коды_07'].join(', ') || 'нет'}`);
    if (s['снимок_искажённые_ответы']) lines.push('Искажённые ответы: ' + s['снимок_искажённые_ответы'].join(', '));
  } else if (s['примечание']) lines.push(s['примечание']);
  lines.push(`Длительность: ${s['длительность_с']} с`);
  return lines;
}

export const isCanDpn = isCanProtocol;
