import { toolContract } from './tool-schema.mjs';

function fileName(item) {
  const value = typeof item === 'string' ? item : item?.name || item?.path || '';
  return String(value).split(/[\\/]/).pop() || 'media';
}

function nonEmptyObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

export function confirmationForPlan(plan, context = {}) {
  const actions = [];
  const changes = [];
  const seen = new Set();
  const add = (type, label, detail = '') => {
    if (seen.has(type)) return;
    seen.add(type);
    actions.push({ type, label, detail });
  };
  const toolContracts = [];

  for (const step of plan?.steps || []) {
    const tool = context.tools?.[step.tool];
    if (!tool) continue;
    const contract = toolContract(tool);
    toolContracts.push(contract);
    if (!contract.requires_confirmation) continue;

    if (contract.name === 'filesystem_mutate') {
      const action = step.input?.action || 'mutation';
      const root = step.input?.root || 'trusted root';
      const path = step.input?.path || (step.input?.expectedHashes ? Object.keys(step.input.expectedHashes).join(', ') : 'patch targets');
      add(`filesystem_${action}`, '确认文件变更', `${action} ${root}/${path}`);
      continue;
    }

    if (contract.name === 'workflow_mutation_commit' || contract.name === 'workflow_rollback') {
      const workflow = step.input?.workflowName || context.workflowName || '当前工作流';
      add(contract.name, contract.name === 'workflow_rollback' ? '回滚工作流' : '修改工作流', `${workflow}${step.input?.diff?.length ? `；${step.input.diff.length} 项变更` : ''}`);
      for (const change of step.input?.diff || []) changes.push(change);
      continue;
    }

    if (contract.side_effects.includes('queue_generation')) add('queue_generation', '提交生成任务', step.input?.workflowName || context.workflowName || '当前工作流');
    for (const change of step.input?.runtimeDiff || step.input?.diff || []) changes.push(change);
    const media = [...(step.input?.images || []), ...(step.input?.masks || []), ...(step.input?.videos || [])];
    if (media.length > 0) add('upload_reference_media', '上传参考媒体', media.map(fileName).join(', '));
    if (nonEmptyObject(step.input?.settings) || nonEmptyObject(step.input?.nodeOverrides) || nonEmptyObject(context.settings) || nonEmptyObject(context.nodeOverrides)) {
      const settings = { ...(step.input?.settings || {}), ...(context.settings || {}) };
      const nodeCount = Object.keys({ ...(step.input?.nodeOverrides || {}), ...(context.nodeOverrides || {}) }).length;
      add('modify_node_parameters', '修改节点参数', `${Object.keys(settings).join(', ') || '提示词'}${nodeCount ? `；${nodeCount} 个节点覆盖` : ''}`);
    } else {
      add('modify_node_parameters', '写入工作流提示词', '仅修改本次运行副本');
    }
    const batch = Number(context.settings?.batch ?? step.input?.settings?.batch ?? 1);
    if (batch > 1) add('batch_generation', '执行批量生成', `${batch} 个结果`);
    if (contract.retry.mode === 'limited') add('limited_retry', '允许有限自动重试', `最多 ${contract.retry.max_attempts || 1} 次；可能更换 seed 并再次排队`);
  }

  if (context.previousWorkflow && context.workflowName && context.previousWorkflow !== context.workflowName) {
    add('change_workflow', '切换工作流', `${context.previousWorkflow} -> ${context.workflowName}`);
  }

  return {
    required: toolContracts.some(contract => contract.requires_confirmation),
    actions,
    changes,
    tools: toolContracts.map(contract => ({
      name: contract.name,
      side_effects: contract.side_effects,
      idempotent: contract.idempotent,
      retry: contract.retry,
    })),
  };
}
