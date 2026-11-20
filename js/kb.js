// База знаний ДВС-чек: карточки кодов, симптомов и справок (data/kb_ru.json).
export function parseKb(json) {
  const cards = json.cards || [];
  const byCode = new Map();
  for (const c of cards) {
    if (c.k !== 'code') continue;
    byCode.set(c.id.toUpperCase(), c);
    for (const a of c.al || []) if (!byCode.has(a.toUpperCase())) byCode.set(a.toUpperCase(), c);
  }
  return {
    size: cards.length,
    forCode: (code) => byCode.get(String(code).trim().toUpperCase()) || null,
    symptoms: cards.filter((c) => c.k === 'symptom'),
    refs: cards.filter((c) => c.k === 'ref'),
  };
}

export function statusNote(card) {
  if (card.st === 'master' || card.st === 'tested') return 'Проверено.';
  if (card.st === 'course') return 'Составлено по материалам курса диагностики, мастером и на машине пока не проверено.';
  return 'Черновик: не проверено мастером и на машине.';
}
