import { emit, AgentEventTypes } from '../events/agent-events.mjs';
import { evaluateTechnical, buildEvaluation } from '../schemas/evaluation-schema.mjs';
import { resolveLLMStrategy } from '../llm/provider.mjs';

export class Evaluator {
  constructor(llmProvider = null, options = {}) {
    this.llm = llmProvider;
    this.imageDataUrl = options.imageDataUrl || null;
  }

  async evaluate(result, userGoal, stepContext = {}, options = {}) {
    const technical = evaluateTechnical(result);
    const promptIssues = Array.isArray(options.promptIssues) ? options.promptIssues : [];
    const hasAlignmentIssue = promptIssues.some(issue => issue.type === 'constraint' || issue.type === 'conflict');

    let vision = null;
    if (this.llm?.isConfigured && !options.skipVision && typeof this.imageDataUrl === 'function') {
      try {
        vision = await this._visionScores(result, userGoal);
      } catch {}
    }

    let constraint;
    if (vision?.constraint) {
      constraint = vision.constraint;
    } else if (hasAlignmentIssue) {
      constraint = {
        status: 'failed',
        passed: false,
        detail: promptIssues.map(issue => issue.detail).filter(Boolean).join('; ') || 'Compiled prompt lost user constraints',
      };
    } else {
      constraint = { status: 'unknown', passed: null, detail: 'Constraint evaluation requires a vision model' };
    }
    const creative = vision?.creative ?? { status: 'not_evaluated', passed: null, detail: 'Creative quality was not evaluated' };
    const issues = this._buildIssues(technical, constraint);
    for (const issue of promptIssues) {
      if (!issues.some(existing => existing.detail === issue.detail)) issues.push(issue);
    }

    const evaluation = buildEvaluation({
      technical,
      constraint,
      creative,
      issues,
      recommendation: this._buildRecommendation(technical, constraint, issues),
    });

    emit(AgentEventTypes.STEP, {
      stepId: stepContext.stepId || 'evaluate',
      tool: 'evaluator',
      status: evaluation.passed ? 'completed' : 'error',
      description: evaluation.summary,
    });

    return evaluation;
  }

  async _visionScores(result, userGoal) {
    try {
      const image = result.images?.[0];
      if (!image) return null;
      const url = await this.imageDataUrl(image);
      if (!url) return null;
      const reply = await this.llm.chat({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: `Rate this generated image against the user request "${userGoal}". Return ONLY JSON {"alignment":0-1,"creative":0-1}.` },
            { type: 'image_url', image_url: { url } },
          ],
        }],
        temperature: 0,
        maxTokens: 300,
        prefer: resolveLLMStrategy(this.llm),
      });
      const content = typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.content || {});
      const cleaned = String(content || '').replace(/^```(?:json|JSON)?\s*/i, '').replace(/```\s*$/i, '').trim();
      const parsed = JSON.parse(cleaned);
      const alignment = Number(parsed.alignment);
      const creative = Number(parsed.creative);
      if (!Number.isFinite(alignment) || !Number.isFinite(creative)) return null;
      return {
        constraint: {
          status: alignment >= 0.6 ? 'passed' : 'failed',
          passed: alignment >= 0.6,
          detail: alignment >= 0.6 ? 'Vision check passed' : 'Vision check: image may not match the request',
        },
        creative: {
          status: creative >= 0.5 ? 'passed' : 'failed',
          passed: creative >= 0.5,
          detail: 'Vision check evaluated creative quality',
        },
      };
    } catch {
      return null;
    }
  }

  _buildIssues(technical, constraint) {
    const issues = [];
    if (!technical.passed) {
      issues.push({ type: 'execution_failure', severity: 'high', detail: technical.detail });
    }
    if (constraint?.status === 'failed') {
      issues.push({ type: 'prompt_mismatch', severity: 'medium', detail: constraint.detail, field: 'prompt' });
    }
    return issues;
  }

  _buildRecommendation(technical, constraint, issues) {
    if (!technical.passed) return { action: 'retry', modification: 'regenerate with same settings', confidence: 0.7 };
    if (constraint?.status === 'failed') return { action: 'rewrite_prompt', modification: constraint.detail?.slice(0, 100) || 'improve prompt alignment', confidence: 0.6 };
    if (issues.length === 0) return { action: 'accept', modification: '', confidence: 1 };
    return { action: 'retry', modification: 'adjust generation parameters', confidence: 0.5 };
  }
}
