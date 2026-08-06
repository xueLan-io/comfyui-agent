const DURATION_PATTERNS = [
  { duration: 5, pattern: /(?:5\s*秒|五秒|5s|5-sec(?:ond)?s?)/i },
  { duration: 10, pattern: /(?:10\s*秒|十秒|10s|10-sec(?:ond)?s?)/i },
];

const MODE_PATTERNS = [
  { mode: 'dialogue', pattern: /(?:文戏|文?戏模式|对白戏|对话戏)/i },
  { mode: 'action', pattern: /(?:武戏|武?戏模式|打戏|动作戏)/i },
  { mode: 'storyboard', pattern: /(?:九宫格|故事板|分镜格)/i },
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
  const modeRules = {
    dialogue: '文戏：围绕一次可见的关系变化组织证据、反应、决定和结果，对白简短并写明语言、口型同步与声音质感。',
    action: '武戏：组织连续可读的攻防因果，每次攻击写明目标、接触、受力和下一动作来源，结尾呈现命中后的物理结果。',
    storyboard: '九宫格：将九个状态按从左到右、从上到下映射到视频时间线；如果已有实际九宫格图片，以实际图像中的主体、姿态、构图和颜色为准。',
  };
  const selectedMode = options.videoMode ? `\n${modeRules[options.videoMode]}` : '';

  return [
    `MiniMax H3 ${duration}秒视频模板：使用中文自然语言，第一行必须以“生成一段${duration}秒、16:9、2K、原生立体声”开头。`,
    `时间线必须无缺口覆盖0—${duration}秒，明确镜头、主体动作、表演、转场和结果。`,
    '按顺序包含“剪辑与动作：”“视觉风格：”“声音设计：”三个段落；只写正向画面、动作和声音描述，不生成 negative prompt。',
    '只用中文双引号标记角色实际说出口的台词，其他制作说明不使用引号；保留用户提供的人物、服装、道具、场景和结局。',
    selectedMode,
  ].join('\n');
}

export function validateMinimaxH3VideoPrompt(prompt, options = {}) {
  const duration = options.duration || 5;
  const text = String(prompt || '').trim();
  const issues = [];
  if (!text.startsWith(`生成一段${duration}秒、`)) issues.push(`第一行必须以生成一段${duration}秒开头`);
  if (!new RegExp(`0[—-]${duration}秒`).test(text)) issues.push(`必须覆盖0—${duration}秒时间线`);
  for (const heading of ['剪辑与动作：', '视觉风格：', '声音设计：']) {
    if (!text.includes(heading)) issues.push(`缺少${heading}`);
  }
  return issues;
}
