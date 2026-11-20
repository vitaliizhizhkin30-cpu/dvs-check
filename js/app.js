import { ElmClient } from './elm.js';
import { PIDS, messages, dtcFromMessages } from './protocol.js';
import { BleTransport, bleSupported, pickDevice } from './transport-ble.js';
import { FakeTransport } from './transport-fake.js';
import { runDiagnostics, summarize } from './diag.js';
import { parseKb, statusNote } from './kb.js';
import { APP_VERSION, buildPassportFile, buildLogText, buildCsv, exportName } from './report.js';

const $ = (id) => document.getElementById(id);
const owner = { brand: null, fuel: null };
let client = null;
let supported = null; // Set PID режима 01
let report = null;
let cancelFlag = false;
let liveRunning = false;
let samples = [];
let dtcDict = null;
let kb = null;
const t0 = performance.now();
const log = [];

$('ver').textContent = APP_VERSION;
if (!bleSupported()) $('unsupported').hidden = false;

// ---------- вкладки ----------
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.pane').forEach((p) => { p.hidden = p.id !== 'tab-' + b.dataset.tab; });
}));

// ---------- выбор владельца (только кнопки, без ввода текста) ----------
const CHOICES = {
  brand: ['Opel', 'Lada', 'Renault', 'VW/Skoda', 'Toyota', 'Hyundai/Kia', 'Другая'],
  fuel: ['Бензин', 'Дизель', 'Не знаю'],
};
for (const [key, values] of Object.entries(CHOICES)) {
  const box = $('chips-' + key);
  for (const v of values) {
    const b = document.createElement('button');
    b.className = 'chip'; b.textContent = v; b.type = 'button';
    b.addEventListener('click', () => {
      owner[key] = owner[key] === v ? null : v;
      box.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x.textContent === owner[key]));
      try { localStorage.setItem('dvs-owner', JSON.stringify(owner)); } catch { /* приватный режим */ }
    });
    box.appendChild(b);
  }
}
try {
  const saved = JSON.parse(localStorage.getItem('dvs-owner') || 'null');
  if (saved) for (const k of ['brand', 'fuel']) {
    owner[k] = saved[k] ?? null;
    $('chips-' + k).querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x.textContent === owner[k]));
  }
} catch { /* ignore */ }

// ---------- журнал ----------
function addLog(dir, text) {
  log.push({ t: (performance.now() - t0) / 1000, dir, text });
  if (log.length > 6000) log.splice(0, 1000);
  const pre = $('log');
  if (pre && $('log-card').open) { pre.textContent += `${dir} ${text}\n`; pre.scrollTop = pre.scrollHeight; }
}
$('log-card').addEventListener('toggle', () => {
  if ($('log-card').open) $('log').textContent = log.map((e) => `${e.dir} ${e.text}`).join('\n');
});

const setStatus = (id, text, cls = '') => { const el = $(id); el.textContent = text; el.className = 'status ' + cls; };

// ---------- подключение ----------
async function connectWith(transport, label) {
  if (client) { try { client.close(); } catch { /* ignore */ } client = null; }
  setStatus('conn-status', 'Подключение к адаптеру…');
  try {
    await transport.open?.();
    client = new ElmClient(transport, { log: addLog });
    setStatus('conn-status', 'Адаптер найден. Настройка и поиск блока управления (до 30 секунд, для K-line дольше)…');
    const r = await client.init();
    supported = null;
    if (r.connected) {
      setStatus('conn-status', `✔ ${label}: связь с блоком есть (${client.dpn}). Откройте «Диагностика».`, 'ok');
      try { supported = await client.readSupportedPids(); } catch { supported = null; }
    } else {
      setStatus('conn-status', `Адаптер работает, но блок управления не ответил (${r.reason}).\nЗажигание включено? Откройте «Диагностика» — приложение переберёт протоколы и сохранит всё для отчёта.`, 'err');
    }
    for (const id of ['btn-run', 'btn-live', 'btn-dtc']) $(id).disabled = false;
  } catch (e) {
    client = null;
    setStatus('conn-status', 'Не удалось подключиться: ' + (e.message || e), 'err');
  }
}

$('btn-connect').addEventListener('click', async () => {
  if (!bleSupported()) { setStatus('conn-status', 'Нет поддержки Bluetooth в этом браузере. Откройте страницу в Bluefy.', 'err'); return; }
  let device;
  try { device = await pickDevice(); } catch (e) { setStatus('conn-status', 'Адаптер не выбран.', ''); return; }
  addLog('•', 'выбран адаптер: ' + (device.name || '(без имени)'));
  const tr = new BleTransport(device);
  await connectWith(tr, device.name || 'Адаптер');
  if (tr.info?.service) addLog('•', 'BLE служба: ' + tr.info.service);
});
$('btn-demo').addEventListener('click', () => connectWith(new FakeTransport('can'), 'Демо'));
$('btn-demo-k').addEventListener('click', () => connectWith(new FakeTransport('needs3'), 'Демо K-line'));

// ---------- диагностика ----------
$('btn-run').addEventListener('click', async () => {
  if (!client) return;
  cancelFlag = false;
  $('btn-run').disabled = true; $('btn-cancel').hidden = false; $('diag-result').hidden = true;
  await keepAwake(true);
  try {
    report = await runDiagnostics(client, { onProgress: (t) => setStatus('diag-progress', t), shouldCancel: () => cancelFlag });
    setStatus('diag-progress', 'Готово.', 'ok');
    $('diag-summary').innerHTML = '';
    for (const l of summarize(report)) { const li = document.createElement('li'); li.textContent = l; $('diag-summary').appendChild(li); }
    $('diag-result').hidden = false;
  } catch (e) {
    setStatus('diag-progress', 'Диагностика прервана: ' + (e.message || e), 'err');
  } finally {
    $('btn-run').disabled = false; $('btn-cancel').hidden = true;
    await keepAwake(false);
  }
});
$('btn-cancel').addEventListener('click', () => { cancelFlag = true; });

function buildFiles() {
  const passport = new File([buildPassportFile(report, owner, navigator.userAgent)], exportName(report, owner, 'passport', 'json'), { type: 'application/json' });
  const logFile = new File([buildLogText(log, `ДВС-чек ${APP_VERSION}\n${navigator.userAgent}`)], exportName(report, owner, 'log', 'txt'), { type: 'text/plain' });
  return [passport, logFile];
}
const textOfReport = () => summarize(report).join('\n');

$('btn-share').addEventListener('click', async () => {
  if (!report) return;
  const files = buildFiles();
  try {
    if (navigator.canShare && navigator.canShare({ files })) {
      await navigator.share({ files, title: 'ДВС-чек: отчёт', text: textOfReport() });
      setStatus('share-status', 'Выберите в меню Telegram и группу «ДВС-чек».', 'ok');
      return;
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
  }
  downloadFiles(files);
  setStatus('share-status', 'Меню «Поделиться» недоступно: файлы скачаны. Откройте «Файлы» и отправьте их в группу вручную.', '');
});
$('btn-download').addEventListener('click', () => { if (report) { downloadFiles(buildFiles()); setStatus('share-status', 'Файлы скачаны.', 'ok'); } });
$('btn-copy').addEventListener('click', async () => {
  if (!report) return;
  const text = buildPassportFile(report, owner, navigator.userAgent);
  try { await navigator.clipboard.writeText(text); setStatus('share-status', 'Скопировано. Вставьте сообщением в группу.', 'ok'); }
  catch { setStatus('share-status', 'Не удалось скопировать: используйте «Скачать файлы».', 'err'); }
});

function downloadFiles(files) {
  files.forEach((f, i) => setTimeout(() => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }, i * 400));
}

// ---------- панель ----------
const dashPids = () => PIDS.filter((p) => p.dash && (!supported || supported.has(p.code)));
const cardEls = new Map();
function buildCards(list, withVoltage) {
  const box = $('cards'); box.innerHTML = ''; cardEls.clear();
  const items = [...list.map((p) => ({ key: p.hex, name: p.name, unit: p.unit })), ...(withVoltage ? [{ key: 'ATRV', name: 'Напряжение (адаптер)', unit: 'В' }] : [])];
  for (const it of items) {
    const d = document.createElement('div'); d.className = 'val';
    d.innerHTML = `<div class="n"></div><div><span class="v">—</span><span class="u"></span></div>`;
    d.querySelector('.n').textContent = it.name; d.querySelector('.u').textContent = it.unit;
    box.appendChild(d); cardEls.set(it.key, d.querySelector('.v'));
  }
  return items;
}
const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));

$('btn-live').addEventListener('click', async () => {
  if (liveRunning) { liveRunning = false; return; }
  if (!client) return;
  liveRunning = true; samples = [];
  $('btn-live').textContent = 'Остановить опрос'; $('btn-csv').disabled = true;
  const list = dashPids();
  const hasVolt = !list.some((p) => p.code === 0x42);
  const cols = buildCards(list, hasVolt);
  await keepAwake(true);
  const started = performance.now(); let misses = 0;
  while (liveRunning) {
    const v = {};
    try {
      for (const p of list) {
        if (!liveRunning) break;
        const x = await client.readPid(p);
        if (x != null) { v[p.hex] = x; cardEls.get(p.hex).textContent = fmt(x); }
      }
      if (hasVolt) { const x = await client.readAdapterVoltage(); if (x != null) { v.ATRV = x; cardEls.get('ATRV').textContent = fmt(x); } }
      misses = 0;
      await new Promise((r) => setTimeout(r, 40)); // отдаём управление интерфейсу (в демо ответы мгновенные)
      if (Object.keys(v).length) samples.push({ t: (performance.now() - started) / 1000, v });
      setStatus('live-status', `Опрос идёт · записей: ${samples.length}`);
    } catch (e) {
      if (++misses >= 4) { setStatus('live-status', 'Связь потеряна: ' + (e.message || e), 'err'); break; }
    }
  }
  liveRunning = false; await keepAwake(false);
  $('btn-live').textContent = 'Начать опрос'; $('btn-csv').disabled = samples.length === 0;
  if (samples.length) setStatus('live-status', `Остановлено. Записей: ${samples.length}. Можно отправить CSV.`);
  $('btn-csv')._cols = cols;
});
$('btn-csv').addEventListener('click', async () => {
  const cols = ($('btn-csv')._cols || []).map((c) => ({ key: c.key }));
  const name = `${owner.brand || 'auto'}_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}_trip.csv`;
  const f = new File([buildCsv(samples, cols)], name, { type: 'text/csv' });
  try { if (navigator.canShare?.({ files: [f] })) { await navigator.share({ files: [f], title: 'ДВС-чек: запись' }); return; } } catch (e) { if (e.name === 'AbortError') return; }
  downloadFiles([f]);
});

// ---------- ошибки ----------
async function loadDict() {
  if (dtcDict) return dtcDict;
  try {
    const j = await (await fetch('data/dtc_ru.json')).json();
    dtcDict = new Map(j.codes.map((c) => [c.code.toUpperCase(), c]));
  } catch { dtcDict = new Map(); }
  return dtcDict;
}
async function loadKb() {
  if (kb) return kb;
  try { kb = parseKb(await (await fetch('data/kb_ru.json')).json()); } catch { kb = parseKb({ cards: [] }); }
  return kb;
}
function kbDetails(card, label) {
  const det = document.createElement('details'); det.className = 'kb';
  const sum = document.createElement('summary'); sum.textContent = label; det.appendChild(sum);
  for (const s of card.secs) {
    const h = document.createElement('h4'); h.textContent = s.h; det.appendChild(h);
    const p = document.createElement('div'); p.className = 'kb-text'; p.textContent = s.t; det.appendChild(p);
  }
  const n = document.createElement('p'); n.className = 'muted small'; n.textContent = statusNote(card); det.appendChild(n);
  return det;
}
async function renderKbList() {
  const k = await loadKb();
  const box = $('kb-list'); box.innerHTML = '';
  const cards = [...k.symptoms, ...k.refs];
  $('kb-title').hidden = cards.length === 0;
  for (const c of cards) {
    const d = document.createElement('div'); d.className = 'card';
    const h = document.createElement('h3'); h.textContent = c.title; d.appendChild(h);
    if (c.rule) { const r = document.createElement('div'); r.textContent = c.rule; d.appendChild(r); }
    d.appendChild(kbDetails(c, 'Открыть')); box.appendChild(d);
  }
}
renderKbList();

$('btn-dtc').addEventListener('click', async () => {
  if (!client) return;
  $('btn-dtc').disabled = true; $('dtc-list').innerHTML = '';
  setStatus('dtc-status', 'Чтение кодов…');
  const dict = await loadDict();
  await loadKb();
  const sets = [['03', 0x43, 'Активные коды'], ['07', 0x47, 'Ожидающие коды (замечены, но не подтверждены)'], ['0A', 0x4a, 'Постоянные коды']];
  let any = false, answered = false;
  for (const [cmd, header, title] of sets) {
    try {
      const lines = await client.send(cmd);
      const ms = messages(lines);
      const h = document.createElement('h3'); h.textContent = title; $('dtc-list').appendChild(h);
      if (!ms.some((m) => m[0] === header)) {
        const p = document.createElement('p'); p.className = 'muted';
        p.textContent = 'Блок не ответил на этот запрос. Это не значит, что кодов нет.'; $('dtc-list').appendChild(p); continue;
      }
      answered = true;
      const codes = dtcFromMessages(ms, client.isCan, header);
      if (!codes.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'Кодов нет.'; $('dtc-list').appendChild(p); }
      for (const code of codes) { any = true; $('dtc-list').appendChild(renderDtc(code, dict.get(code), kb?.forCode(code))); }
    } catch (e) {
      const p = document.createElement('p'); p.className = 'muted'; p.textContent = `${title}: ошибка связи (${e.message})`; $('dtc-list').appendChild(p);
    }
  }
  setStatus('dtc-status', answered ? (any ? 'Коды найдены. Справка примерная, не диагноз.' : 'Блок ответил: кодов нет.') : 'Блок не ответил ни на один запрос кодов.', answered && !any ? 'ok' : '');
  $('btn-dtc').disabled = false;
});

function renderDtc(code, info, card) {
  const d = document.createElement('div');
  d.className = 'card dtc u' + (info?.urgency ?? 2);
  const h = document.createElement('h3'); h.textContent = `${code} — ${info?.title ?? 'код не найден в справочнике'}`; d.appendChild(h);
  const p = document.createElement('div');
  p.textContent = info?.meaning ?? 'Расшифровки этого кода в справочнике нет. Для кодов производителя (P1xxx) значение зависит от марки и блока.';
  d.appendChild(p);
  if (info?.causes?.length) { const ul = document.createElement('ul'); info.causes.forEach((c) => { const li = document.createElement('li'); li.textContent = c; ul.appendChild(li); }); d.appendChild(ul); }
  if (card) d.appendChild(kbDetails(card, 'Подробная справка'));
  return d;
}

// ---------- экран не гаснет ----------
let wake = null;
async function keepAwake(on) {
  try {
    if (on && navigator.wakeLock && !wake) wake = await navigator.wakeLock.request('screen');
    else if (!on && wake) { await wake.release(); wake = null; }
  } catch { wake = null; }
}
