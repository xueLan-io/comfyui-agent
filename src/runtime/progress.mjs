function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstNumber(values) {
  for (const value of values) {
    const number = finiteNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function normalizePercent(data, previousPercent = null) {
  const direct = firstNumber([data.percent, data.progress]);
  const current = firstNumber([data.value, data.current, data.step]);
  const total = firstNumber([data.max, data.total, data.steps]);
  let percent = direct;

  if (percent === null && current !== null && total !== null && total > 0) {
    percent = (current / total) * 100;
  }
  if (percent !== null && percent >= 0 && percent <= 1 && direct !== null) percent *= 100;
  if (percent === null) percent = previousPercent;
  return percent === null ? null : Math.max(0, Math.min(100, Math.round(percent)));
}

export function normalizeProgressEvent(event = {}, previous = null) {
  const data = event && typeof event === 'object' ? event : {};
  const current = firstNumber([data.value, data.current, data.step]);
  const total = firstNumber([data.max, data.total, data.steps]);
  const nodePercent = normalizePercent({ percent: data.nodePercent, value: data.value, max: data.max }, previous?.nodePercent ?? null);
  const overallPercent = data.overallPercent !== undefined
    ? normalizePercent({ percent: data.overallPercent }, previous?.overallPercent ?? null)
    : null;
  const percent = overallPercent ?? normalizePercent(data, previous?.percent ?? null);
  const node = data.nodeType || data.node || data.nodeId || '';
  const message = data.message || (node ? `正在执行 ${node}` : data.stage === 'retrying' ? '正在重试' : '正在生成');

  return {
    ...data,
    percent,
    overallPercent,
    nodePercent,
    percentScope: data.percentScope || (overallPercent !== null ? 'overall' : nodePercent !== null ? 'node' : 'stage'),
    indeterminate: percent === null,
    message,
    node: String(node),
    current: current === null ? 0 : current,
    total: total === null ? 0 : total,
  };
}
