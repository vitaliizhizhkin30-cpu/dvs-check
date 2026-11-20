// Формирование файлов выгрузки: JSON-паспорт, полный журнал обмена, CSV поездки.
export const APP_VERSION = 'web 0.1';

const slug = (s) => String(s ?? '').normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
const stamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

/** Имя файла: Марка-Год_VIN_дата_тип.расш — только из данных, определённых автоматически, + выбор владельца как запасной вариант. */
export function exportName(report, owner, type, ext, d = new Date()) {
  const s = report.сводка;
  const vin = s['VIN'] || (s['CAL_ID']?.[0] ? 'cal-' + slug(s['CAL_ID'][0]) : 'noid');
  const brand = slug(owner?.brand) || 'auto';
  return `${brand}_${vin}_${stamp(d)}_${type}.${ext}`;
}

/** Заголовок-обёртка выгрузки (авто_* — определено приложением, владелец_* — подсказка пользователя). */
export function buildPassportFile(report, owner, userAgent = '') {
  const s = report.сводка;
  const wrap = {
    выгрузка: {
      приложение: 'ДВС-чек ' + APP_VERSION,
      создано: new Date().toISOString(),
      авто_VIN: s['VIN'] ?? null,
      авто_CAL_ID: s['CAL_ID'] ?? [],
      авто_протокол: s['протокол'],
      авто_подключено_к_блоку: s['подключено'],
      владелец_марка: owner?.brand ?? null,
      владелец_топливо: owner?.fuel ?? null,
      браузер: userAgent,
    },
    данные: report,
  };
  return JSON.stringify(wrap, null, 2);
}

export function buildLogText(log, header = '') {
  const lines = log.map((e) => `${e.t.toFixed(2).padStart(8)}  ${e.dir} ${e.text}`);
  return (header ? header + '\n\n' : '') + lines.join('\n') + '\n';
}

export function buildCsv(samples, columns) {
  const head = ['time_s', ...columns.map((c) => c.key)].join(',');
  const rows = samples.map((s) => [s.t.toFixed(1), ...columns.map((c) => (s.v[c.key] ?? ''))].join(','));
  return head + '\n' + rows.join('\n') + '\n';
}
