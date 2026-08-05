import { applyGuard } from '../../optimizer/prompt-guard.mjs';
import { publicAppearanceContext } from '../../research/appearance.mjs';
import { attachVisionImages } from '../../runtime/chat-vision.mjs';
import modelProfiles from '../../../config/modelProfiles.json' with { type: 'json' };

const STYLE_TEMPLATES = {
  raw: { name: 'Original', instruction: 'Preserve the user prompt without stylistic additions.' },
  cinematic: { name: 'Cinematic', instruction: 'Strengthen composition, lighting, lens, atmosphere, and visual storytelling.' },
  anime: { name: 'Anime', instruction: 'Use anime and illustration vocabulary appropriate for the selected model.' },
  'anime-character': { name: 'Anime Character', instruction: 'Prioritize character identity, age, face, hair, eyes, clothing, accessories, silhouette, expression, and pose. Do not invent a setting unless the user supplied one.' },
  'anime-scene': { name: 'Anime Scene', instruction: 'Prioritize environment, spatial relationships, camera distance, perspective, lighting, atmosphere, and background while preserving the character details exactly.' },
  'anime-polish': { name: 'Anime Polish', instruction: 'Improve rendering quality, line clarity, hands, eyes, anatomy, color harmony, and background cleanliness without changing the subject, pose, clothing, or composition.' },
  photorealistic: { name: 'Photorealistic', instruction: 'Use photographic composition, material, and lighting language when the model supports it.' },
  concept: { name: 'Concept Art', instruction: 'Clarify silhouette, composition, palette, atmosphere, and design intent.' },
};

function mergeTerms(baseline, additions) {
  const terms = [];
  const seen = new Set();
  for (const value of [baseline, additions]) {
    for (const term of String(value || '').split(',').map(item => item.trim()).filter(Boolean)) {
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      terms.push(term);
    }
  }
  return terms.join(', ');
}

const REFERENCE_REQUEST = /(?:\u57fa\u4e8e|\u6839\u636e|\u6309\u7167|\u6309|\u53c2\u8003)?(?:\u4e0a\u8ff0|\u4e0a\u9762|\u4e4b\u524d|\u521a\u624d|\u8fd9\u4e2a|\u8fd9\u5f20|\u5b83|\u8be5)[\s\S]{0,16}(?:\u751f\u6210|\u753b|\u521b\u5efa|\u51fa\u56fe|\u56fe\u7247|generate|draw|render|image)/i;
const GENERATION_REFERENCE = /(?:\u751f\u6210|\u753b|\u521b\u5efa|\u51fa\u56fe|generate|draw|render)[\s\S]{0,16}(?:\u4e0a\u8ff0|\u4e0a\u9762|\u4e4b\u524d|\u521a\u624d|\u8fd9\u4e2a|\u8fd9\u5f20|\u5b83|\u8be5|this|that|above|previous)[\s\S]{0,16}(?:\u56fe\u7247|\u56fe|image|picture)/i;
const GENERATION_REQUEST = /(?:\u751f\u6210|\u753b|\u7ed8\u5236|\u521b\u5efa|\u5236\u4f5c|\u51fa\u56fe|\u751f\u56fe|generate|draw|render|create|make)/i;
const IMAGE_PROMPT_REQUEST = /(?:\u53cd\u63a8|\u63d0\u53d6|\u8bc6\u522b|\u63cf\u8ff0|\u5206\u6790)[\s\S]{0,20}(?:\u63d0\u793a\u8bcd|prompt)/i;
const REFINEMENT_REQUEST = /(?:\u6362\u6210|\u6362\u4e2a|\u6539\u6210|\u8c03\u6574|\u4f18\u5316|\u518d\u6765\u4e00\u5f20|\u91cd\u505a|change|adjust|refine|improve)/i;
const HAIR_COLOR = /\b(red|blue|green|yellow|black|white|purple|violet|pink|orange|brown|grey|gray|gold|silver)\b/i;
const EXECUTE_LAST_PROMPT = /^(?:\u6267\u884c|\u8fd0\u884c|\u5f00\u59cb(?:\u751f\u6210|\u6267\u884c)?|\u6309(?:\u539f\u63d0\u793a|\u4e0a\u6b21\u63d0\u793a)\u751f\u6210|run|execute)$/i;

function replaceHairColor(baseline, addition) {
  if (!/\b(?:hair|haired)\b/i.test(addition)) return baseline;
  const color = addition.match(HAIR_COLOR)?.[1];
  if (!color) return baseline;
  return baseline.replace(
    new RegExp(`\\b(?:red|blue|green|yellow|black|white|purple|violet|pink|orange|brown|grey|gray|gold|silver)(?=(?:[- ]?haired| hair)\\b)`, 'gi'),
    color,
  );
}

function mergeRefinementPrompt(baseline, addition) {
  const base = String(baseline || '').trim();
  const update = String(addition || '').trim();
  if (!base) return update;
  if (!update || update.toLowerCase().includes(base.toLowerCase())) return update || base;
  const updated = replaceHairColor(base, update);
  if (updated !== base && /^(?:a|an|the)?\s*(?:red|blue|green|yellow|black|white|purple|violet|pink|orange|brown|grey|gray|gold|silver)?[- ]?(?:hair|haired)\s*$/i.test(update)) {
    return updated;
  }
  return mergeTerms(updated, update);
}

function needsPromptResolution(prompt, contextPrompt = '') {
  const value = String(prompt || '').trim();
  return EXECUTE_LAST_PROMPT.test(value) || REFERENCE_REQUEST.test(value) || GENERATION_REFERENCE.test(value) || GENERATION_REQUEST.test(value) || IMAGE_PROMPT_REQUEST.test(value) || Boolean(contextPrompt && REFINEMENT_REQUEST.test(value));
}

function parsePromptResolution(content) {
  const cleaned = String(content || '').replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  const parsed = JSON.parse(cleaned);
  if (!parsed || typeof parsed.prompt !== 'string' || !parsed.prompt.trim()) throw new Error('Prompt resolver returned an invalid JSON shape');
  return parsed.prompt.trim();
}

async function resolvePrompt(prompt, conversation, contextPrompt, llmProvider, onChunk, requireAI = false, intent = '', referenceImages = [], imageDataUrl = null, options = {}) {
  const isRefinement = intent === 'refine' || REFINEMENT_REQUEST.test(prompt);
  if (!needsPromptResolution(prompt, contextPrompt) && !(contextPrompt && isRefinement)) return { prompt, resolved: false };
  if (contextPrompt && EXECUTE_LAST_PROMPT.test(String(prompt).trim())) {
    return { prompt: contextPrompt, resolved: true, source: 'lastPrompt' };
  }

  const context = [
    contextPrompt ? { role: 'context', content: contextPrompt } : null,
    ...(Array.isArray(conversation) ? conversation : []),
  ].filter(item => item?.content).slice(-8);

  if (llmProvider) {
    try {
      const resolverMessages = await attachVisionImages(
        [
          {
            role: 'system',
            content: `# 角色
你将用户的最新生成请求解析为发送给图像模型的视觉提示词。

# 输出
仅返回 JSON：{"prompt": "..."}

# 解析逻辑（按顺序）
1. 若最新请求是纯动作指令（如“生成这张图”“再试一次”），则重复最近的视觉描述
2. 若最新请求是修改指令（如“改成夜景”“换红色衣服”），则合并修改到前一视觉描述中，而非重复旧描述
3. 若最新请求包含全新的视觉描述，则直接使用该描述

# 引用解析
- “上面的”“刚才的”“这张”“这个” → 指最近一条视觉描述
- “之前那张” → 指上一条视觉描述
- 参考范围：仅追溯当前对话会话内的视觉描述

# 禁止放入 prompt 的内容
- 问候语、致谢、请求动词、命令、解释
- 引号
- “生成一张图”等元语言
- 非英文内容（用户指定的专有名词除外）

# 合并示例
- 用户：“一只白猫坐在窗台上” → prompt: “a white cat sitting on windowsill”
- 用户：“改成黑猫” → prompt: “a black cat sitting on windowsill”（合并，非重复）
- 用户：“再生成一次” → prompt: “a white cat sitting on windowsill”（重复最近）

# 约束
- 全部用英文撰写（专有名词保留原样）
- 保留上下文和最新请求中的明确视觉细节
- 若无法解析引用，则使用最新请求的内容本身`,
          },
          {
            role: 'user',
            content: JSON.stringify({
              latestRequest: prompt,
              recentContext: context,
              referenceImages: referenceImages.length,
            }),
          },
        ],
        referenceImages,
        imageDataUrl,
      );
      const result = await llmProvider.chat({
        messages: resolverMessages,
        temperature: 0,
        maxTokens: 500,
        prefer: 'local',
        timeoutMs: 30000,
        onChunk,
        allowPolicyOverride: options.allowPolicyOverride === true,
      });
      const resolved = parsePromptResolution(result.content);
      return {
        prompt: contextPrompt && isRefinement ? mergeRefinementPrompt(contextPrompt, resolved) : resolved,
        resolved: true,
        source: 'conversation',
      };
    } catch (error) {
      if (requireAI) throw error;
      // The normal prompt compiler can still handle the original request.
    }
  }

  if (contextPrompt && (REFERENCE_REQUEST.test(prompt) || GENERATION_REFERENCE.test(prompt))) {
    return { prompt: contextPrompt, resolved: true, source: 'lastPrompt' };
  }
  if (contextPrompt && REFINEMENT_REQUEST.test(prompt)) {
    return { prompt: mergeRefinementPrompt(contextPrompt, prompt), resolved: true, source: 'lastPrompt' };
  }
  return { prompt, resolved: false };
}

function rawResult(prompt, mode, profile, existingNegative, constraints, note, requestPrompt = prompt, resolution = {}) {
  const supportsNegative = profile.supportsNegative !== false;
  return {
    original: requestPrompt,
    sourcePrompt: prompt,
    promptResolved: resolution.resolved || false,
    tags: [],
    narrative: prompt,
    positive: prompt,
    negative: supportsNegative ? existingNegative : '',
    enhanced: prompt,
    mode,
    modelType: profile.family || 'generic',
    constraints: constraints || {},
    issues: [],
    ...(note ? { note } : {}),
  };
}

function aiFailureResult(originalRequest, error) {
  const failure = {
    aiFailure: true,
    originalRequest,
    error: error instanceof Error ? error.message : String(error),
  };
  if (error?.code === 'CLOUD_POLICY_BLOCKED') {
    failure.code = error.code;
    failure.policyDecision = error.policyDecision || null;
  }
  return failure;
}

function compilerInstructions(profile, styleInstruction, customInstruction, feedback = '') {
  const family = String(profile.family || 'generic').toLowerCase();
  const modelProfile = modelProfiles[family] || modelProfiles.generic;
  const common = `# 角色
你是 ComfyUI 提示词编译器，将用户请求转换为模型可用的正/负提示词。

# 输出格式
返回单个有效 JSON：{"tags": [], "narrative": "", "positive": "", "negative": "", "self_check": {}}
不返回 Markdown 或解释。

# 输入优先级（高→低）
1. interpretedPrompt（请求解析器的输出）——作为视觉内容来源
2. referenceContext（结构化的角色外观事实）——仅使用有证据支持的字段
3. 用户原始描述——仅当上述两者未提供时使用
4. constraints——强制遵守，不得违反

# 内容来源规则
- interpretedPrompt 是视觉内容的唯一来源。不得将请求动词、致谢、对话回复或元语言（如“生成一张图”）放入 positive 或 narrative
- referenceContext：仅使用 hair、eyes、outfit、accessories、silhouette 中有证据支持的字段。证据引用和来源标题**不作为提示词内容**
- 用户指定的专有名词（角色名、品牌）保留原样

# self_check 规则（必须执行）
self_check 必须包含：
- preserved: boolean —— 以下任何一项未保留则为 false
- issues: string[] —— 具体列出问题

**必须检查的冲突类型：**
1. 角色身份/姓名是否改变
2. 角色数量是否改变（“2girls”不能变“1girl”）
3. 年龄是否改变
4. 指定服装/颜色是否改变或丢失
5. positive 与 negative 是否矛盾（如 positive 有“smile”，negative 有“smile”）

# 模型族规则（分叉处理）
模型规则将在下方追加。

# 风格方向
遵循 styleInstruction 和 customInstruction（如有）：${styleInstruction}${customInstruction ? `\nAdditional direction: ${customInstruction}` : ''}

# 模型格式规则（从外部配置加载）
遵循以下格式规则：
${JSON.stringify(modelProfile, null, 2)}

# 特殊约束（针对当前模型族）
${family === 'anima' ? '- 标签块顺序：质量 → 主体数量 → 角色身份 → 艺术家标签 → 外观 → 姿态 → 场景。权重标签如 (属性:权重) 仅用于真实视觉属性。转义系列名中的括号。' : ''}
${family === 'flux' ? '- 不创建传统 negative prompt。' : ''}
${family === 'wan' || family === 'animatediff' ? '- positive 必须包含明确的运动/时间/相机运动描述。' : ''}

# 约束
  - Anima 的 artist 位只保留用户明确指定或已有提示词中的 artist token；**不得发明**艺术家名，也不要把普通风格词当作 artist token
- 保持在 token 预算内（超限由外部截断，故优先精简）
- 全部用英文撰写（专有名词除外），句子内不混用语言
- 遵循提供的工作流格式和 negative 能力，不发明不支持的字段${feedback ? `

# 上次自检未通过，请修正以下问题
${feedback}` : ''}`;

  return common;
}

function parseCompiled(content) {
  const cleaned = String(content || '').replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  const parsed = JSON.parse(cleaned);
  if (!parsed || !Array.isArray(parsed.tags) || typeof parsed.narrative !== 'string' || typeof parsed.positive !== 'string' || typeof parsed.negative !== 'string') {
    throw new Error('Prompt compiler returned an invalid JSON shape');
  }
  return parsed;
}

function normalizeCompiled(parsed, input) {
  const profile = input.promptProfile || {};
  const family = String(profile.family || input.modelType || 'generic').toLowerCase();
  const tags = parsed.tags.map(tag => String(tag).trim()).filter(Boolean);
  const narrative = parsed.narrative.trim();
  let positive = parsed.positive.trim();
  let negative = parsed.negative.trim();

  if (family === 'anima') positive = [tags.join(', '), narrative].filter(Boolean).join('\n\n');
  if (family === 'flux' || profile.supportsNegative === false) negative = '';
  else negative = mergeTerms(input.existingNegative || profile.currentNegative, negative);

  const selfCheck = parsed.self_check && typeof parsed.self_check === 'object'
    ? {
        preserved: typeof parsed.self_check.preserved === 'boolean' ? parsed.self_check.preserved : false,
        issues: Array.isArray(parsed.self_check.issues) ? parsed.self_check.issues.map(String) : ['Invalid self_check.issues'],
      }
    : { preserved: false, issues: ['Missing self_check'] };
  const issues = [];
  if (selfCheck && !selfCheck.preserved) {
    issues.push({
      type: 'constraint',
      severity: 'high',
      detail: selfCheck.issues.length ? selfCheck.issues.join('; ') : 'compiled prompt did not preserve user constraints',
    });
  }

  return {
    original: input.requestPrompt || input.prompt,
    sourcePrompt: input.prompt,
    promptResolved: input.promptResolved || false,
    tags,
    narrative,
    positive,
    negative,
    enhanced: positive,
    mode: input.mode,
    modelType: family,
    constraints: input.constraints || {},
    selfCheck,
    issues,
  };
}

function preserveRefinementBaseline(compiled, sourcePrompt, intent) {
  if (intent !== 'refine' || !sourcePrompt || !compiled?.positive) return compiled;
  const sourceWords = sourcePrompt.trim().split(/\s+/).filter(Boolean).length;
  const compiledWords = compiled.positive.trim().split(/\s+/).filter(Boolean).length;
  if (compiledWords >= Math.max(4, Math.ceil(sourceWords * 0.6))) return compiled;
  return {
    ...compiled,
    positive: sourcePrompt,
    enhanced: sourcePrompt,
  };
}

export const PromptEnhanceTool = {
  name: 'prompt_enhance',
  description: 'Compile text into a model-aware prompt. It cannot queue generation, upload media, or change workflow nodes.',
  category: 'enhancement',
  tags: ['prompt', 'compile', 'workflow'],
  timeout_ms: 30000,
  side_effects: [],
  requires_confirmation: false,
  idempotent: false,
  retry: { mode: 'limited', max_attempts: 1 },
  output_schema: {
    type: 'object',
    properties: {
      original: { type: 'string' },
      sourcePrompt: { type: 'string' },
      promptResolved: { type: 'boolean' },
      tags: { type: 'array', items: { type: 'string' } },
      narrative: { type: 'string' },
      positive: { type: 'string' },
      negative: { type: 'string' },
      enhanced: { type: 'string' },
      mode: { type: 'string' },
      modelType: { type: 'string' },
      constraints: { type: 'object' },
      error: { type: 'string' },
    },
  },
  input_schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Original user prompt' },
      mode: { type: 'string', enum: Object.keys(STYLE_TEMPLATES) },
      modelType: { type: 'string' },
      promptProfile: { type: 'object' },
      existingNegative: { type: 'string' },
      constraints: { type: 'object' },
      customInstruction: { type: 'string' },
      budgets: { type: 'object', description: 'Token budgets: { positiveTokens, negativeTokens }' },
      llmProvider: { type: 'object' },
      conversation: { type: 'array', description: 'Recent conversation used to resolve references in the latest request' },
      contextPrompt: { type: 'string', description: 'Last actual visual prompt, used as a local fallback' },
      intent: { type: 'string', description: 'Generation intent; refine keeps the previous prompt as the baseline' },
      referenceContext: { type: 'object', description: 'Untrusted public web references for character appearance' },
    },
    required: ['prompt'],
  },

  async execute(input) {
    const {
      prompt,
      mode = 'raw',
      customInstruction,
      llmProvider,
      onChunk,
      promptProfile = {},
      existingNegative = promptProfile.currentNegative || '',
      constraints = {},
      conversation = [],
      contextPrompt = '',
      intent = '',
      referenceContext = null,
      referenceImages = [],
      imageDataUrl = null,
      requireAI = false,
    } = input;

    if (requireAI && !llmProvider) {
      return aiFailureResult(prompt, 'AI generation requires a configured language model');
    }

    let resolution;
    try {
      resolution = await resolvePrompt(
        prompt,
        conversation,
        contextPrompt,
        llmProvider,
        onChunk,
        requireAI,
        intent,
        referenceImages,
        imageDataUrl,
        { allowPolicyOverride: input.allowPolicyOverride === true },
      );
    } catch (error) {
      return aiFailureResult(prompt, error);
    }
    const sourcePrompt = resolution.prompt;

    if (mode === 'raw' && !customInstruction && (!requireAI || resolution.source === 'lastPrompt')) {
      return rawResult(sourcePrompt, mode, promptProfile, existingNegative, constraints, undefined, prompt, resolution);
    }

    if (!llmProvider) {
      return rawResult(sourcePrompt, mode, promptProfile, existingNegative, constraints, 'No LLM provider available, returned original', prompt, resolution);
    }

    const template = STYLE_TEMPLATES[mode] || STYLE_TEMPLATES.concept;
    let instruction = customInstruction;
    if (constraints.task === 'video') {
      const videoRule = 'This is a video request: describe motion, timing, camera movement, and scene continuity explicitly in the narrative.';
      instruction = instruction ? `${instruction}. ${videoRule}` : videoRule;
    }
    try {
      let compiled;
      let lastIssues = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const feedback = attempt > 0
          ? lastIssues.map((issue, index) => `${index + 1}. ${issue}`).join('\n')
          : '';
        const compilerMessages = await attachVisionImages(
          [
            { role: 'system', content: compilerInstructions(promptProfile, template.instruction, instruction, feedback) },
            {
              role: 'user',
              content: JSON.stringify({
                modelType: promptProfile.family || input.modelType || 'generic',
                format: promptProfile.format || 'narrative',
                latestRequest: prompt,
                interpretedPrompt: sourcePrompt,
                recentContext: conversation,
                existingNegative,
                supportsNegative: promptProfile.supportsNegative !== false,
                constraints,
                budgets: input.budgets || null,
                referenceContext: publicAppearanceContext(referenceContext),
                referenceImages: referenceImages.length,
              }),
            },
          ],
          referenceImages,
          imageDataUrl,
        );
        const result = await llmProvider.chat({
          messages: compilerMessages,
          temperature: 0.3,
          maxTokens: 1200,
          prefer: 'local',
          timeoutMs: 45000,
          onChunk,
          allowPolicyOverride: input.allowPolicyOverride === true,
        });

        compiled = normalizeCompiled(parseCompiled(result.content), {
          ...input,
          prompt: sourcePrompt,
          requestPrompt: prompt,
          promptResolved: resolution.resolved,
          promptProfile,
          existingNegative,
          constraints,
          mode,
        });
        compiled = preserveRefinementBaseline(compiled, sourcePrompt, intent);
        lastIssues = compiled.selfCheck?.issues || [];
        if (compiled.selfCheck?.preserved === true) break;
        if (attempt === 2) {
          const unresolved = 'UNRESOLVED: 经过3次重试仍无法通过自检';
          compiled.selfCheck.issues.push(unresolved);
          compiled.issues.push({ type: 'constraint', severity: 'high', detail: unresolved });
        }
      }
      return applyGuard(compiled, { userPrompt: sourcePrompt, budgets: input.budgets });
    } catch (error) {
      if (requireAI) return aiFailureResult(prompt, error);
      return { ...rawResult(sourcePrompt, mode, promptProfile, existingNegative, constraints, undefined, prompt, resolution), error: error.message };
    }
  },
  getStrategies() {
    return Object.entries(STYLE_TEMPLATES).map(([key, value]) => ({ id: key, name: value.name }));
  },
};
