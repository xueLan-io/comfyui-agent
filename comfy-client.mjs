import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const BASE = 'http://127.0.0.1:8188';

export class ComfyClient {
  async queuePrompt(prompt) {
    const res = await fetch(`${BASE}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prompt),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ComfyUI queue failed (${res.status}): ${text.slice(0, 500)}`);
    }
    return res.json();
  }

  async getQueue() {
    const res = await fetch(`${BASE}/queue`);
    return res.json();
  }

  async getHistory(promptId) {
    const res = await fetch(`${BASE}/history/${promptId}`);
    return res.json();
  }

  async interrupt() {
    await fetch(`${BASE}/interrupt`, { method: 'POST' });
  }

  async waitForCompletion(promptId, pollMs = 1000, timeoutMs = 600000) {
    const start = Date.now();
    for (;;) {
      const queue = await this.getQueue();
      const running = queue.queue_running || [];
      const pending = queue.queue_pending || [];
      const isStillQueued = running.some(r => r[0] === promptId) || pending.some(r => r[0] === promptId);
      if (!isStillQueued) {
        const history = await this.getHistory(promptId);
        if (history[promptId]) return history[promptId];
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      if (Date.now() - start > timeoutMs) throw new Error('Timeout waiting for completion');
      await new Promise(r => setTimeout(r, pollMs));
    }
  }

  async loadWorkflow(filePath) {
    const text = await readFile(filePath, 'utf-8');
    return JSON.parse(text);
  }

  async fetchObjectInfo() {
    const res = await fetch(`${BASE}/object_info`);
    return res.json();
  }

  workflowToPrompt(workflow, objectInfo = {}) {
    const prompt = {};
    const linkMap = {};
    const rerouteNodes = new Set();
    const mode0Nodes = new Set();

    for (const node of workflow.nodes || []) {
      const id = String(node.id);
      if (node.mode === 4) continue;
      mode0Nodes.add(id);
      if (node.type === 'Reroute') rerouteNodes.add(id);
    }

    for (const link of workflow.links || []) {
      const [linkId, srcNode, srcOut] = link;
      linkMap[linkId] = { srcNode: String(srcNode), srcOut };
    }

    function resolveSource(nodeId, outputIdx) {
      const id = String(nodeId);
      if (rerouteNodes.has(id)) {
        const node = workflow.nodes.find(n => String(n.id) === id);
        const inputs = node?.inputs || [];
        for (const inp of inputs) {
          if (inp.link != null && inp.link >= 0) {
            const link = linkMap[inp.link];
            if (link) return resolveSource(link.srcNode, link.srcOut);
          }
        }
      }
      return [id, outputIdx];
    }

    function getInputOrder(typeDef) {
      if (!typeDef) return [];
      const order = [];
      for (const key of typeDef.input_order?.required || []) {
        const config = typeDef.input?.required?.[key];
        order.push({ name: key, config, optional: false });
      }
      for (const key of typeDef.input_order?.optional || []) {
        const config = typeDef.input?.optional?.[key];
        order.push({ name: key, config, optional: true });
      }
      return order;
    }

    function countWidgets(inputOrder) {
      let count = 0;
      for (const entry of inputOrder) {
        if (!entry.config) continue;
        const type = entry.config[0];
        if (['INT', 'FLOAT', 'STRING'].includes(type) || Array.isArray(type)) {
          count++;
          const props = entry.config[1] || {};
          if (props.control_after_generate) count++;
        }
      }
      return count;
    }

    for (const node of workflow.nodes || []) {
      const id = String(node.id);
      if (node.mode === 4 || rerouteNodes.has(id)) continue;
      prompt[id] = { class_type: node.type, inputs: {} };
    }

    for (const node of workflow.nodes || []) {
      const id = String(node.id);
      if (node.mode === 4 || rerouteNodes.has(id)) continue;
      const p = prompt[id];
      const vals = node.widgets_values || [];
      const typeDef = objectInfo[node.type];
      const inputOrder = getInputOrder(typeDef);
      const inputs = node.inputs || [];
      let widgetIdx = 0;

      for (const entry of inputOrder) {
        const name = entry.name;
        const input = inputs.find(inp => inp.name === name);
        const hasLink = input && input.link != null && input.link >= 0;
        const config = entry.config;
        if (!config) continue;
        const type = config[0];
        const props = config[1] || {};
        const isWidgetType = ['INT', 'FLOAT', 'STRING', 'BOOLEAN'].includes(type) || Array.isArray(type);

        if (hasLink) {
          const link = linkMap[input.link];
          if (link) {
            const [srcId, srcOut] = resolveSource(link.srcNode, link.srcOut);
            if (mode0Nodes.has(srcId)) {
              p.inputs[name] = [srcId, srcOut];
            }
          }
          if (isWidgetType) {
            widgetIdx++;
            if (props.control_after_generate) widgetIdx++;
          }
        } else if (isWidgetType) {
          if (widgetIdx < vals.length) {
            p.inputs[name] = vals[widgetIdx];
          }
          widgetIdx++;
          if (props.control_after_generate) widgetIdx++;
        }
      }
    }
    return prompt;
  }

  getOutputPaths(result, workflowPath) {
    const outputs = result.outputs || {};
    const images = [];
    for (const nodeId of Object.keys(outputs)) {
      const nodeOutputs = outputs[nodeId];
      for (const key of Object.keys(nodeOutputs)) {
        const items = nodeOutputs[key];
        if (Array.isArray(items)) {
          for (const item of items) {
            if (item.filename) {
              images.push(item);
            }
          }
        }
      }
    }
    return images;
  }
}
