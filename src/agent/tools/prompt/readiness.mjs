const GENERATION_COMMAND = /^(?:帮我)?(?:生成|画|绘制|出图|生图|创建|做)(?:一张|一个|一幅|个|张)?/i;
const SETTINGS = /(?:\bseed\b|种子|步数|steps?|cfg|引导系数|采样器|scheduler|尺寸|分辨率|\d{2,5}\s*[x×*]\s*\d{2,5})/gi;
const ABSTRACT = /(高级感|氛围感|有感觉|好看|漂亮|大气|质感|电影感|科技感|高级|vibe|premium|beautiful|cinematic)/i;
const CHANGE_VALUE = /(红|蓝|绿|黄|黑|白|橙|紫|粉|颜色|色调|风格|背景|光影|灯光|构图|姿势|镜头|比例|夜景|白天|油画|水彩|change|color|style|lighting|background|composition)/i;
const DETAIL_DIRECTION = /(清晰度?|锐度|细节|动作|姿势|表情|手势|\bsharpness\b|\bdetails?\b|\bpose\b|\baction\b)/i;
const CONTRADICTION = /(?:8k|超高清|高清|清晰).*?(?:模糊|失焦)|(?:模糊|失焦).*?(?:8k|超高清|高清|清晰)/i;

const EXECUTE_LAST_PROMPT = /^(?:\u6267\u884c|\u8fd0\u884c|\u5f00\u59cb(?:\u751f\u6210|\u6267\u884c)?|\u6309(?:\u539f\u63d0\u793a|\u4e0a\u6b21\u63d0\u793a)\u751f\u6210|run|execute)$/i;

export function hasRefinementDirection(text = '') {
  return CHANGE_VALUE.test(text) || DETAIL_DIRECTION.test(text);
}

function hasMedia(media = {}, lastImages = []) {
  return Boolean(
    media?.images?.length ||
    media?.masks?.length ||
    media?.videos?.length ||
    lastImages?.length,
  );
}

function subjectText(request = '') {
  return request
    .replace(EXECUTE_LAST_PROMPT, '')
    .replace(GENERATION_COMMAND, '')
    .replace(/^(?:generate|draw|render|create|make|want)\s+(?:an?\s+)?(?:image|picture)?/i, '')
    .replace(SETTINGS, '')
    .replace(/[，。！？、,:;；!?]/g, ' ')
    .replace(/(?:请|帮我|一下|图片|图像|图|画面|image|picture|an image|a picture)/gi, ' ')
    .trim();
}

function hasRecentVisualContext(conversation = []) {
  return conversation.some(message => {
    if (message?.role !== 'assistant' || message.kind === 'clarification') return false;
    const content = String(message.content || '').trim();
    return content.length >= 40;
  });
}

export function assessPromptReadiness({ request = '', intent = 'generate', media, lastImages, lastPrompt = '', conversation = [] } = {}) {
  const missing = [];
  const warnings = [];
  const conflicts = [];
  const text = String(request).trim();

  if (intent === 'edit' && !hasMedia(media, lastImages)) missing.push('reference_media');
  if (intent === 'refine' && !lastPrompt && !hasMedia(media, lastImages)) missing.push('previous_generation');

  if (intent === 'refine' && !hasRefinementDirection(text)) missing.push('refinement_direction');
  if (intent === 'edit' && !text.replace(/(?:把这张图|这张图|参考图|图生图|img2img|改成|换成|重绘|修改|处理|一下|风格|油画|水彩)/gi, '').trim()) {
    missing.push('new_value');
  }

  const hasContextPrompt = Boolean(lastPrompt) || hasRecentVisualContext(conversation) || hasMedia(media, lastImages);
  if ((intent === 'generate' || intent === 'edit') && !subjectText(text)
    && (!hasContextPrompt || (EXECUTE_LAST_PROMPT.test(text) && !lastPrompt && !lastImages?.length))) {
    missing.push('subject');
  }
  if (ABSTRACT.test(text)) warnings.push('描述包含抽象要求，生成前会转换为具体的视觉语言。');
  if (CONTRADICTION.test(text)) conflicts.push('同时包含清晰和模糊要求，请确认优先级。');

  const uniqueMissing = [...new Set(missing)];
  const uniqueConflicts = [...new Set(conflicts)];
  const blocking = [...uniqueMissing, ...uniqueConflicts];
  let question = '';
  if (uniqueMissing.includes('reference_media')) question = '请先附加参考图片，或说明要基于哪一张历史图片修改。';
  else if (uniqueMissing.includes('previous_generation')) question = '请先生成一张图片，或附加要修改的参考图。';
  else if (uniqueMissing.includes('refinement_direction')) question = '你想优先调整哪一项：配色、构图、光影还是风格？';
  else if (uniqueMissing.includes('new_value')) question = '请说明要改成什么，例如“换成红色”或“改成夜景”。';
  else if (uniqueMissing.includes('subject')) question = '你想生成什么主体或画面？';
  else if (uniqueConflicts.length) question = uniqueConflicts[0];

  return {
    readiness: blocking.length ? 'clarify' : warnings.length ? 'warn' : 'ready',
    missing: uniqueMissing,
    warnings,
    conflicts: uniqueConflicts,
    question,
  };
}
