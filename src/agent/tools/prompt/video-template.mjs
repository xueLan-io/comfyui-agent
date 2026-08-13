const DURATION_PATTERNS = [
  { duration: 5, pattern: /(?:5\s*秒|五秒|5s|5-sec(?:ond)?s?)/i },
  { duration: 10, pattern: /(?:10\s*秒|十秒|10s|10-sec(?:ond)?s?)/i },
];

const MODE_PATTERNS = [
  { mode: 'dialogue', pattern: /(?:文戏|文?戏模式|对白戏|对话戏)/i },
  { mode: 'action', pattern: /(?:武戏|武?戏模式|打戏|动作戏)/i },
  { mode: 'storyboard', pattern: /(?:九宫格|故事板|分镜格)/i },
  { mode: 'director', pattern: /(?:自由导演|自由模式|混合叙事)/i },
];

export function detectVideoTemplateOptions(message = '', context = {}) {
  const text = String(message);
  const duration = DURATION_PATTERNS.find(item => item.pattern.test(text))?.duration || null;
  const videoMode = MODE_PATTERNS.find(item => item.pattern.test(text))?.mode || null;
  const family = String(context.modelType || context.promptProfile?.family || '').toLowerCase();

  if (family !== 'minimax_h3' || (!duration && !videoMode)) return null;
  return {
    template: 'minimax_h3_video',
    ...(duration ? { duration } : {}),
    ...(videoMode ? { videoMode } : {}),
  };
}

export function minimaxH3VideoInstruction(options = {}) {
  const duration = options.duration || 5;
  const actionBudget = duration <= 5
    ? '默认安排4—7个关键动作；只有用户明确要求高密度战斗时才提高到6—10个。'
    : '默认安排7—12个关键动作；只有用户明确要求高密度战斗时才提高到10—16个。';
  const modeRules = {
    dialogue: '文戏：围绕一次可见的关系变化组织证据、反应、决定和结果。对白只保留能推动变化的一至四句短句，写明说话人、语言、口型同步与声音质感；结尾留出结果或表情余波。',
    action: `武戏：组织连续且可读的攻防因果。${actionBudget}每个关键动作写清起手或空间关系、目标或接触点、受力结果和下一动作来源；优先保证人物身份、运动方向和接触结果清楚，不堆砌无法辨认的招式；结尾呈现命中、卸力或胜负落地。`,
    storyboard: '九宫格：将九个状态按从左到右、从上到下映射到视频时间线。已有实际九宫格图片时，以实际图像中的主体、姿态、构图、道具和颜色为准；没有实际九宫格图片时，不得声称已经观察到成图，只描述需要生成的九格状态与映射关系。',
    director: '自由导演：不预设文戏或武戏。先提炼一个核心变化，再用最少但足够清楚的镜头、动作和表演承载它；可以组合对白、观察、追逐、环境变化和声音桥，但每个事件都必须推动同一结果，不能堆砌无后果的场面。',
  };
  const selectedMode = options.videoMode ? `\n${modeRules[options.videoMode]}` : '';

  return [
    `MiniMax H3 ${duration}秒视频模板：使用中文自然语言，第一行必须以“生成一段${duration}秒、16:9、2K、原生立体声”开头。`,
    `时间线必须无缺口覆盖0—${duration}秒。每个时间段写明镜头或景别、稳定的主体锚点、主动作或表演、进入或离开方式，以及可见结果；时间段可以硬切，但用运动方向、道具、视线、色彩或声音桥保持连续。`,
    '按顺序包含“剪辑与动作：”“视觉风格：”“声音设计：”三个段落；只写需要出现的画面、动作、声音和结果。把“不要模糊”“不要多余人物”之类约束改写为清晰主体、稳定人数、可读接触点等正向结果；不生成 negative prompt。',
    '用户明确给出的人物数量、身份、服装、道具、场景、镜头、动作、对白和结局属于硬约束，不能被风格化改写。只用中文双引号标记角色实际说出口的台词，其他制作说明不使用引号。',
    '结尾必须给出至少一个可见的最终状态，例如行为完成、关系改变、胜负落地、物体状态改变或明确的停留画面。',
    selectedMode,
  ].join('\n');
}

export function validateMinimaxH3VideoPrompt(prompt, options = {}) {
  const duration = options.duration || 5;
  const text = String(prompt || '').trim();
  const productionText = text.replace(/[“"][^”"]*[”"]/g, '');
  const issues = [];
  if (!text.startsWith(`生成一段${duration}秒、`)) issues.push(`第一行必须以生成一段${duration}秒开头`);
  if (!hasCompleteTimeline(text, duration)) issues.push(`必须无缺口覆盖0—${duration}秒时间线`);
  for (const heading of ['剪辑与动作：', '视觉风格：', '声音设计：']) {
    if (!text.includes(heading)) issues.push(`缺少${heading}`);
  }
  if (/(?:negative\s*prompt|负面提示词|负向提示词)/i.test(productionText)) issues.push('MiniMax H3 不应输出 negative prompt 或负面提示词');
  if (/(?:不要|避免|禁止|严禁)\S{0,16}/.test(productionText)) issues.push('将否定式约束改写为正向可见结果');
  if (!/(?:完成|结束|最终|最后|结果|落地|停在|定格|胜出|离开|停留|改变|余波)/.test(text)) {
    issues.push('缺少可见的结尾结果或最终状态');
  }
  if (options.videoMode === 'dialogue' && !/(?:对白|台词|说[：，,]|低声说|说道|开口)/.test(text)) {
    issues.push('文戏需要包含推动关系变化的对白或明确表演反应');
  }
  if (options.videoMode === 'action' && !/(?:攻击|闪避|格挡|命中|反击|接触|受力|劈|击|挡|踢|刺|挥)/.test(text)) {
    issues.push('武戏需要包含可读的攻防、接触或受力结果');
  }
  if (options.videoMode === 'storyboard' && !/(?:九宫格|故事板|1[—-]9|1至9|1到9|九格)/.test(text)) {
    issues.push('九宫格模式需要说明九格或1—9状态映射');
  }
  return issues;
}

function hasCompleteTimeline(text, duration) {
  const ranges = [...String(text).matchAll(/(\d+(?:\.\d+)?)\s*[—-]\s*(\d+(?:\.\d+)?)\s*秒/g)]
    .map(match => ({ start: Number(match[1]), end: Number(match[2]) }))
    .filter(range => Number.isFinite(range.start) && range.start >= 0 && range.end <= duration + 0.01 && range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (ranges.length === 0) return false;

  let cursor = 0;
  for (const range of ranges) {
    if (range.end <= cursor) continue;
    if (range.start > cursor + 0.01) return false;
    cursor = Math.max(cursor, range.end);
  }
  return cursor >= duration - 0.01;
}
