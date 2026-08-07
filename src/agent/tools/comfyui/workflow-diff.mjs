function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function workflowDiff(operations = [], workflow) {
  const nodes = new Map((workflow?.nodes || []).map(node => [String(node.id), node]));
  const result = [];
  for (const operation of operations) {
    const node = nodes.get(String(operation.nodeId));
    const nodeType = node?.type || '';
    let from;
    let path;
    if (operation.op === 'set_property') {
      from = node?.[operation.path];
      path = operation.path;
    } else if (operation.op === 'set_input' || operation.op === 'set_widget') {
      from = operation.from;
      path = operation.op === 'set_input' ? `inputs.${operation.input}` : `widgets_values[${operation.index}]`;
    }
    if (Object.is(from, operation.value)) continue;
    result.push({
      op: operation.op,
      nodeId: String(operation.nodeId),
      nodeType,
      ...(operation.input !== undefined ? { input: operation.input } : {}),
      ...(operation.index !== undefined ? { index: operation.index } : {}),
      path,
      from: clone(from),
      to: clone(operation.value),
      reversible: true,
    });
  }
  return result.sort((a, b) => String(a.nodeId).localeCompare(String(b.nodeId), undefined, { numeric: true })
    || String(a.path).localeCompare(String(b.path))
    || String(a.op).localeCompare(String(b.op)));
}

export function inverseWorkflowDiff(diff = []) {
  return diff.map(item => ({ ...item, from: clone(item.to), to: clone(item.from) }));
}
