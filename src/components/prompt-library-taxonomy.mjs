const CHARACTER_CATEGORY_IDS = [
  'character-role',
  'character-face',
  'character-eyes',
  'character-hair',
  'character-expression',
  'character-build',
  'character-clothing',
  'character-pose',
  'character-action',
  'character-accessory',
  'character-detail',
];

const CHARACTER_COLLECTED_GROUPS = [
  '上半身', '下半身', '身体装饰', '人物动作', '发型', '头部装饰', '9_动作姿态/站坐姿态',
  '3_人物主体/职业身份', '3_人物主体/种族', '3_人物主体/体型年龄', '耳朵', '身体特征', '颈部',
  '服装', '面部特征', '鞋袜', '5_五官表情/表情', '5_五官表情/面部细节', '6_服装配饰/上身服装',
  '6_服装配饰/下身服装', '6_服装配饰/鞋袜', '6_服装配饰/配饰', '10_物品道具/日常物品',
  '10_物品道具/武器', '物品', '0_画质基础/品质词', '12_负面提示/画质缺陷', '画质',
];

const COLLECTED_CHARACTER_TERMS = [
  '1girl', '1boy', '2girls', '2boys', 'solo', 'character', 'person', 'woman', 'man', 'girl', 'boy',
  'face', 'eye', 'iris', 'pupil', 'eyelash', 'eyebrow', 'gaze', 'looking', 'hair', 'bangs', 'ponytail',
  'braid', 'smile', 'laugh', 'cry', 'angry', 'expression', 'body', 'breast', 'chest', 'arm', 'hand',
  'finger', 'leg', 'thigh', 'knee', 'foot', 'shoe', 'dress', 'skirt', 'shirt', 'jacket', 'coat',
  'uniform', 'armor', 'sock', 'hat', 'ear', 'earring', 'necklace', 'glove', 'ring', 'tattoo', 'pose',
  'standing', 'sitting', 'kneeling', 'walking', 'holding', 'reading', 'playing', 'cooking',
];

function compileCollectedTerm(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll(' ', '[ _]+');
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i');
}

function collectedNode(groups, searchTerms) {
  return { collectedGroups: groups, collectedSearchTerms: searchTerms, collectedTermPatterns: searchTerms.map(compileCollectedTerm) };
}

const CHARACTER_NODE_RULES = {
  upperDecoration: collectedNode(['上半身', '6_服装配饰/上身服装'], ['armband', 'armlet', 'badge', 'brooch', 'ribbon', 'sleeve', 'harness']),
  lowerDecoration: collectedNode(['下半身'], ['garter', 'thighband', 'leg belt', 'anklet', 'pelvic']),
  fullDecoration: collectedNode(['10_物品道具/日常物品', '10_物品道具/武器', '物品'], ['backpack', 'camera', 'book', 'flower', 'lantern', 'umbrella', 'sword', 'weapon']),
  action: collectedNode(['人物动作', '9_动作姿态/动态动作', '9_动作姿态/手部姿态'], ['holding', 'reading', 'writing', 'playing', 'cooking', 'drinking', 'eating', 'dancing', 'running']),
  quality: collectedNode(['0_画质基础/品质词', '12_负面提示/画质缺陷', '画质'], ['quality', 'masterpiece', 'highres', 'resolution', 'blurry', 'lowres', 'artifacts']),
  hair: collectedNode(['发型'], ['hair', 'bangs', 'ponytail', 'braid', 'pigtail', 'bob']),
  headAccessory: collectedNode(['头部装饰'], ['hat', 'hairpin', 'hair ribbon', 'headpiece']),
  pose: collectedNode(['9_动作姿态/站坐姿态', '方向与视线'], ['pose', 'standing', 'sitting', 'seated', 'kneeling', 'crouching', 'looking']),
  role: collectedNode(['角色与作品', '人物类型', '3_人物主体/职业身份', '3_人物主体/种族', '3_人物主体/体型年龄'], ['1girl', '1boy', 'solo', 'character', 'person', 'woman', 'man', 'girl', 'boy']),
  ear: collectedNode(['耳朵'], ['ear', 'ears', 'animal ears']),
  chest: collectedNode(['身体特征', '上半身'], ['breast', 'breasts', 'chest', 'bust', 'collarbone']),
  neck: collectedNode(['颈部'], ['neck', 'choker', 'scarf']),
  clothing: collectedNode(['服装', '6_服装配饰/上身服装', '6_服装配饰/下身服装'], ['shirt', 'blouse', 'sweater', 'jacket', 'coat', 'hoodie', 'uniform', 'dress', 'skirt', 'pants', 'trousers', 'jeans', 'robe', 'gown', 'armor']),
  face: collectedNode(['面部特征', '5_五官表情/表情', '5_五官表情/面部细节'], ['face', 'nose', 'lip', 'mouth', 'cheek', 'jaw', 'chin', 'freckle', 'dimple', 'eyebrow', 'eye', 'iris', 'pupil', 'eyelash', 'gaze', 'smile', 'laugh', 'cry', 'expression']),
  socks: collectedNode(['鞋袜', '6_服装配饰/鞋袜'], ['stocking', 'sock', 'shoe', 'boots', 'heels', 'loafer', 'sneaker']),
};

const CHARACTER_BUCKET_ORDER = ['quality', 'socks', 'ear', 'neck', 'headAccessory', 'chest', 'upperDecoration', 'lowerDecoration', 'fullDecoration', 'clothing', 'hair', 'face', 'role', 'action', 'pose'];

function matchesCollectedRule(item, rule) {
  const searchText = item.searchText || `${item.title || ''}\n${item.description || ''}\n${item.prompt || ''}`.toLowerCase();
  const matchesGroup = rule.collectedGroups?.includes(item.tagGroup) || (rule.tagGroup && rule.tagGroup === item.tagGroup);
  const matchesTerm = rule.collectedTermPatterns?.some(pattern => pattern.test(searchText));
  if (rule.collectedMatch === 'term') return Boolean(matchesTerm);
  if (rule.collectedMatch === 'group-and-no-term') return Boolean(matchesGroup && !rule.collectedExcludeTerms.some(term => searchText.includes(term)));
  return Boolean(matchesGroup || matchesTerm);
}

const CLOTHING_UPPER = [
  'clothing-white-shirt', 'clothing-linen-blouse', 'clothing-knit-sweater',
  'clothing-tailored-suit', 'clothing-leather-jacket', 'clothing-denim-jacket',
  'clothing-trench-coat', 'clothing-wool-coat', 'clothing-hoodie',
];

const CLOTHING_LOWER = [
  'clothing-pleated-skirt', 'clothing-wide-trousers', 'clothing-jeans', 'clothing-cargo-pants',
];

const CLOTHING_FULL = [
  'clothing-sundress', 'clothing-evening-gown', 'clothing-traditional-robe',
  'clothing-fantasy-armor', 'clothing-travel-clothes', 'clothing-work-apron', 'clothing-athletic-wear',
];

const CLOTHING_MATERIAL = ['clothing-silk', 'clothing-cotton'];
const FOOT_SOCKS = ['clothing-stockings', 'clothing-knee-high-socks', 'clothing-ankle-boots', 'clothing-loafers'];
const BODY_STRUCTURE = [
  'build-slender', 'build-athletic', 'build-muscular', 'build-curvy', 'build-petite', 'build-tall',
  'build-broad-shoulders', 'build-narrow-shoulders', 'build-compact', 'build-relaxed', 'build-upright',
  'build-graceful', 'build-energetic', 'build-weary', 'build-elderly', 'build-soft', 'build-defined',
  'build-natural', 'build-balanced',
];
const CHEST_STRUCTURE = ['build-chest', 'detail-collarbone', 'accessory-brooch', 'accessory-chest-ribbon'];
const HEAD_DECORATION = [
  'accessory-beret', 'accessory-wide-hat', 'accessory-hairpin', 'accessory-hair-ribbon',
];

const EAR_DECORATION = ['accessory-earrings', 'accessory-hoop-earrings', 'detail-silver-ear'];
const NECK_DECORATION = ['accessory-necklace', 'accessory-scarf', 'detail-neck-tattoo'];
const UPPER_DECORATION = ['accessory-scarf', 'accessory-brooch', 'accessory-chest-ribbon'];
const LOWER_DECORATION = ['accessory-anklet'];
const BODY_DECORATION = ['accessory-leather-gloves', 'accessory-wristwatch', 'accessory-bracelet', 'accessory-ring', 'detail-arm-tattoo'];
const FULL_BODY_DECORATION = ['accessory-backpack', 'accessory-leather-bag', 'accessory-camera', 'accessory-book', 'accessory-flower', 'accessory-lantern', 'accessory-umbrella', 'accessory-sword'];

const ACTION_EXPRESSION_CHILDREN = [
  { id: 'expression', label: '表情情绪', description: '喜怒哀乐、神态和面部情绪', categoryIds: ['character-expression'], collectedGroups: ['面部特征', '5_五官表情/表情'], collectedSearchTerms: ['expression', 'smile', 'laugh', 'cry', 'angry', 'sad', 'surprised', 'shy'] },
  { id: 'action-pose', label: '动作姿态', description: '站坐、移动和身体动作', categoryIds: ['character-pose', 'character-action'], collectedGroups: ['人物动作', '9_动作姿态/动态动作', '9_动作姿态/站坐姿态'], collectedSearchTerms: ['pose', 'standing', 'sitting', 'walking', 'running', 'jumping', 'dancing', 'kneeling'], curatedTerms: ['站立', '坐', '跪', '蹲', '倚', '侧转', '歪头', '托腮', '脸颊', '叉腰', '交叉', '插袋', '背后', '双臂', '抬起', '张开', '行走', '迈步', '侧身', '三分之四姿势', '站姿', '奔跑', '跳跃', '跳舞', '伸展'] },
  { id: 'action-hands', label: '手部行为', description: '手势、抓握和正在进行的行为', categoryIds: ['character-action'], collectedGroups: ['9_动作姿态/手部姿态'], collectedSearchTerms: ['hand', 'finger', 'holding', 'grabbing', 'reading', 'writing', 'playing', 'cooking'], curatedTerms: ['手', '捧', '扶', '撑', '持', '提', '触', '握', '指', '弹奏', '书写', '阅读', '拍照', '拿', '端', '烹饪', '整理', '绘画', '拍摄', '品茶', '施放'] },
  { id: 'action-gaze', label: '视线方向', description: '人物朝向、视线和观看关系', categoryIds: ['character-pose', 'character-action'], collectedGroups: ['方向与视线'], collectedSearchTerms: ['gaze', 'looking', 'staring', 'facing', 'eye contact', 'looking away'], curatedTerms: ['回头', '看', '望', '视线', '凝视', '注视', '仰望', '窗外', '天空', '仰头'] },
];

const COMPOSITION_CHILDREN = [
  { id: 'composition-framing', label: '取景范围', description: '特写、半身、全身和远近景', categoryIds: ['composition'], collectedGroups: ['构图与镜头', '构图'], collectedSearchTerms: ['close-up', 'headshot', 'portrait', 'half body', 'full body', 'wide shot', 'long shot', 'macro'], curatedTerms: ['特写', '半身', '全身', '宽幅', '越肩', '微距', '全景', '头像', '远景', '局部', '门框'] },
  { id: 'composition-angle', label: '视角透视', description: '平视、俯视、低角度和空间透视', categoryIds: ['composition'], collectedGroups: ['透视与视角', '2_构图视角/镜头距离', '2_构图视角/视角方向'], collectedSearchTerms: ['angle', 'perspective', 'eye level', 'low angle', 'high angle', 'overhead', 'top-down', 'profile', 'three-quarter'], curatedTerms: ['低角度', '俯拍', '侧面', '倾斜', '俯瞰', '无人机', '等距', '剖面', '三分之四', '平视', '极低视角', '正上方', '透视'] },
  { id: 'composition-layout', label: '画面布局', description: '主体位置、对称、留白和视觉动线', categoryIds: ['composition'], collectedGroups: ['构图', '2_构图视角/构图方式'], collectedSearchTerms: ['composition', 'centered', 'symmetry', 'rule of thirds', 'leading lines', 'negative space', 'framing', 'diagonal'], curatedTerms: ['三分法', '引导线', '中心对称', '镜像', '不对称', '框中框', '倒影', '对角线', '前景', '剪影', '分割画面', '留白', '抓拍', '运动轨迹', '景深'] },
  { id: 'composition-format', label: '画幅格式', description: '竖幅、横幅、方形和全景画面', categoryIds: ['composition'], collectedGroups: ['画面格式'], collectedSearchTerms: ['vertical', 'horizontal', 'square', 'panoramic', 'banner', 'poster', 'aspect ratio'], curatedTerms: ['竖幅', '方形', '横幅'] },
];

const SCENE_CHILDREN = [
  { id: 'scene-interior', label: '室内空间', description: '房间、室内建筑和生活场景', categoryIds: ['environment'], collectedGroups: ['室内环境', '7_场景背景/室内场景'], collectedSearchTerms: ['interior', 'room', 'cafe', 'kitchen', 'bedroom', 'office', 'studio'], curatedTerms: ['室内', '图书馆', '咖啡', '工作室', '地铁', '温室', '古堡', '火车', '机场', '飞船', '实验室', '教室', '剧院', '博物馆'] },
  { id: 'scene-outdoor', label: '自然环境', description: '森林、海岸、植物和户外自然', categoryIds: ['environment'], collectedGroups: ['室外环境', '自然环境', '7_场景背景/自然场景', '花卉植物', '11_动植物/植物'], collectedSearchTerms: ['forest', 'tree', 'garden', 'flower', 'plant', 'ocean', 'coast', 'mountain', 'desert', 'nature'], curatedTerms: ['森林', '荒漠', '海边', '太空', '花园', '雪峰', '湖', '村落', '港口', '瀑布', '珊瑚', '极地', '雨林', '峡谷', '梯田', '薰衣草', '草甸', '果园', '葡萄', '渔村'] },
  { id: 'scene-city', label: '城市建筑', description: '城市街道、建筑和人工空间', categoryIds: ['environment'], collectedGroups: ['城市', '建筑', '7_场景背景/城市建筑'], collectedSearchTerms: ['city', 'street', 'building', 'architecture', 'urban', 'road', 'shop', 'skyscraper'], curatedTerms: ['雨夜', '集市', '屋顶', '古寺', '小巷', '游乐园', '天文台'] },
  { id: 'scene-time-weather', label: '时间天气', description: '昼夜、季节、天气和天空变化', categoryIds: ['environment'], collectedGroups: ['天空天气', '7_场景背景/时间天气'], collectedSearchTerms: ['day', 'night', 'sunset', 'sunrise', 'rain', 'snow', 'cloud', 'weather', 'dusk', 'dawn'], curatedTerms: ['雪中'] },
  { id: 'scene-elements', label: '物品元素', description: '道具、交通工具和画面中的附加元素', categoryIds: ['subject'], collectedGroups: ['物品', '10_物品道具/日常物品', '10_物品道具/武器', '10_物品道具/特效元素', '画面元素'], collectedSearchTerms: ['object', 'prop', 'weapon', 'vehicle', 'book', 'flower', 'food', 'particle'], curatedTerms: ['静物', '建筑主体', '美食', '交通工具', '摩托', '珠宝', '古籍', '陶瓷', '帆船', '精密', '蘑菇', '面具', '昆虫', '标本'] },
];

const LIGHTING_CHILDREN = [
  { id: 'lighting-source', label: '光源方向', description: '窗光、逆光、轮廓光和棚拍布光', categoryIds: ['lighting'], collectedGroups: ['8_色彩光线/光照'], collectedSearchTerms: ['light', 'lighting', 'backlight', 'rim light', 'window light', 'studio light', 'spotlight', 'softbox'], curatedTerms: ['窗光', '逆光', '棚拍', '轮廓光', '侧面硬光', '蝴蝶光', '伦勃朗', '聚光灯', '柔光', '补光', '实用光', '凝胶', '正午硬光', '频闪', '钨丝', '荧光冷光'] },
  { id: 'lighting-time', label: '时间氛围', description: '晨光、黄金时刻、月光和夜景照明', categoryIds: ['lighting'], collectedGroups: ['8_色彩光线/光照', '7_场景背景/时间天气'], collectedSearchTerms: ['golden hour', 'sunrise', 'sunset', 'moonlight', 'candlelight', 'night lighting', 'neon'], curatedTerms: ['黄金时刻', '日出', '落日', '蓝调', '月下', '烛火', '火焰', '霓虹', '闪电'] },
  { id: 'lighting-color', label: '色温色调', description: '冷暖、黑白、粉彩和整体色彩方向', categoryIds: ['lighting'], collectedGroups: ['色彩', '8_色彩光线/色调'], collectedSearchTerms: ['color', 'palette', 'warm', 'cool', 'monochrome', 'pastel', 'saturated', 'duotone'], curatedTerms: ['黑白', '粉彩', '高调', '低调', '明暗', '极光'] },
  { id: 'lighting-effects', label: '阴影效果', description: '阴影、光晕、体积光和空气效果', categoryIds: ['lighting'], collectedGroups: ['视觉效果', '10_物品道具/特效元素'], collectedSearchTerms: ['shadow', 'glow', 'bloom', 'volumetric', 'fog', 'haze', 'flare', 'spark'], curatedTerms: ['体积光', '阴天', '树影', '辉光', '水下', '生物荧光', '光柱', '折射', '光晕', '环境漫光'] },
];

const STYLE_CHILDREN = [
  { id: 'style-medium', label: '绘画媒介', description: '水彩、油画、素描和水墨等媒介', categoryIds: ['style'], collectedGroups: ['艺术风格/绘画媒介', '艺术风格', '1_艺术风格/绘画风格'], collectedSearchTerms: ['watercolor', 'oil painting', 'ink', 'charcoal', 'sketch', 'painting', 'drawing'], curatedTerms: ['水彩画', '油画', '水墨', '炭笔', '铅笔', '粉彩绘画', '不透明水彩', '木刻', '马赛克', '彩色玻璃', '瓷器', '木版', '纸雕', '黏土'] },
  { id: 'style-school', label: '艺术流派', description: '经典流派、现代潮流和艺术表现', categoryIds: ['style'], collectedGroups: ['艺术风格/经典流派', '艺术风格/现代潮流', '艺术表现'], collectedSearchTerms: ['impressionism', 'surrealism', 'minimalism', 'art nouveau', 'expressionism', 'pop art', 'abstract'], curatedTerms: ['超现实', '蒸汽朋克', '赛博朋克', '新艺术', '几何', '浮世绘', '哥特', '极简', '粗野', '蒸汽波', '合成波'] },
  { id: 'style-anime-photo', label: '影像方向', description: '动漫、电影、摄影和编辑视觉', categoryIds: ['style'], collectedGroups: ['艺术风格/数字风格', '1_艺术风格/数字艺术'], collectedSearchTerms: ['anime', 'manga', 'cinematic', 'photography', 'editorial', 'film', 'documentary', 'illustration'], curatedTerms: ['电影剧照', '动漫', '杂志', '胶片', '漫画', '图像小说', '绘本'] },
  { id: 'style-render', label: '渲染质感', description: '三维渲染、材质表现和成像质感', categoryIds: ['style'], collectedGroups: ['0_画质基础/渲染效果', '艺术风格/数字风格'], collectedSearchTerms: ['3d', 'render', 'realistic', 'photorealistic', 'texture', 'material', 'ray tracing', 'cgi'], curatedTerms: ['三维', '低多边形', '概念背景', '科幻概念', '奇幻概念', '建筑可视化', '时装速写', '像素', '定格动画'] },
];

const QUALITY_CHILDREN = [
  { id: 'quality-clarity', label: '清晰度', description: '高分辨率、锐度和主体边缘', categoryIds: ['detail'], collectedGroups: ['画质', '0_画质基础/品质词'], collectedSearchTerms: ['quality', 'masterpiece', 'highres', 'high resolution', 'sharp', 'detailed', 'focus'], curatedTerms: ['清晰', '高精细', '干净', '线条', '焦点', '边缘', '对比度', '写实'] },
  { id: 'quality-texture', label: '材质细节', description: '皮肤、织物、表面和细节质感', categoryIds: ['detail'], collectedGroups: ['身体特征', '服装'], collectedSearchTerms: ['texture', 'fabric', 'skin', 'material', 'fine detail', 'surface', 'intricate'], curatedTerms: ['丰富材质', '发丝', '服装', '饰品', '皮肤', '金属', '玻璃', '木材', '石材', '水珠', '纹样', '半透明', '次表面', '岁月', '镜面', '五官', '眼神'] },
  { id: 'quality-depth', label: '空间层次', description: '景深、空气透视和前中后景关系', categoryIds: ['detail'], collectedGroups: ['视觉效果', '背景'], collectedSearchTerms: ['depth', 'depth of field', 'foreground', 'background', 'atmospheric perspective', 'bokeh', 'layered'], curatedTerms: ['空间层次', '空气透视', '透视统一', '尺度', '影调', '阴影', '烟雾', '尘埃', '雨', '雪花', '粒子'] },
  { id: 'quality-defects', label: '问题规避', description: '模糊、画质缺陷和不希望出现的内容', categoryIds: ['detail'], collectedGroups: ['12_负面提示/画质缺陷', '12_负面提示/内容过滤'], collectedSearchTerms: ['blurry', 'lowres', 'bad anatomy', 'artifact', 'watermark', 'text', 'deformed'], curatedTerms: ['人体结构', '瑕疵', '手部'] },
];

export const PROMPT_LIBRARY_TAXONOMY = [
  {
    id: 'featured',
    label: '精选常用',
    description: '经过整理的基础片段，适合直接开始组合',
    source: 'curated',
  },
  {
    id: 'character',
    label: '人物',
    description: '人物主体、外观、服装、动作和装饰',
    categoryIds: CHARACTER_CATEGORY_IDS,
    ...collectedNode(CHARACTER_COLLECTED_GROUPS, COLLECTED_CHARACTER_TERMS),
    children: [
      { id: 'upper-decoration', label: '上身装饰', description: '上半身服装和胸前、手臂装饰', categoryIds: ['character-accessory', 'character-clothing'], itemIds: UPPER_DECORATION, collectedBucket: 'upperDecoration', ...CHARACTER_NODE_RULES.upperDecoration },
      { id: 'lower-decoration', label: '下身装饰', description: '下半身服装和腿部装饰', categoryIds: ['character-accessory', 'character-clothing'], itemIds: LOWER_DECORATION, collectedBucket: 'lowerDecoration', ...CHARACTER_NODE_RULES.lowerDecoration },
      { id: 'full-body-decoration', label: '全身装饰', description: '随身物品、道具和武器', categoryIds: ['character-accessory'], itemIds: FULL_BODY_DECORATION, collectedBucket: 'fullDecoration', ...CHARACTER_NODE_RULES.fullDecoration },
      { id: 'character-action', label: '动作', description: '人物正在进行的动作和手部行为', categoryIds: ['character-action'], collectedBucket: 'action', ...CHARACTER_NODE_RULES.action },
      { id: 'quality', label: '品控', description: '画质、清晰度和常见质量控制标签', categoryIds: ['detail'], itemIds: [], collectedBucket: 'quality', ...CHARACTER_NODE_RULES.quality },
      { id: 'character-hair', label: '头发', description: '发型、发色、刘海和发丝动态', categoryIds: ['character-hair'], collectedBucket: 'hair', ...CHARACTER_NODE_RULES.hair },
      { id: 'head-decoration', label: '头部饰品', description: '帽子、发饰和头部配件', categoryIds: ['character-accessory'], itemIds: HEAD_DECORATION, collectedBucket: 'headAccessory', ...CHARACTER_NODE_RULES.headAccessory },
      { id: 'character-pose', label: '摆位', description: '站坐、身体朝向和镜头前姿态', categoryIds: ['character-pose'], collectedBucket: 'pose', ...CHARACTER_NODE_RULES.pose },
      { id: 'character-role', label: '类型', description: '人物类型、职业、种族和角色定位', categoryIds: ['character-role'], collectedBucket: 'role', ...CHARACTER_NODE_RULES.role },
      { id: 'ear-decoration', label: '耳朵', description: '耳朵、耳形和耳部特征', categoryIds: ['character-accessory', 'character-detail'], itemIds: EAR_DECORATION, collectedBucket: 'ear', ...CHARACTER_NODE_RULES.ear },
      { id: 'character-chest', label: '胸部', description: '胸部、胸口、锁骨和上半身关系', categoryIds: ['character-build', 'character-detail', 'character-accessory'], itemIds: CHEST_STRUCTURE, collectedBucket: 'chest', ...CHARACTER_NODE_RULES.chest },
      { id: 'neck-decoration', label: '脖子', description: '脖颈、项圈、围巾和颈部细节', categoryIds: ['character-accessory', 'character-detail'], itemIds: NECK_DECORATION, collectedBucket: 'neck', ...CHARACTER_NODE_RULES.neck },
      { id: 'clothing', label: '衣装', description: '上装、下装、连体装和制服', categoryIds: ['character-clothing'], itemIds: CLOTHING_UPPER.concat(CLOTHING_LOWER, CLOTHING_FULL, CLOTHING_MATERIAL), collectedBucket: 'clothing', ...CHARACTER_NODE_RULES.clothing },
      { id: 'character-face', label: '面部', description: '脸型、五官、眼睛和表情', categoryIds: ['character-face', 'character-eyes', 'character-expression'], collectedBucket: 'face', ...CHARACTER_NODE_RULES.face },
      { id: 'foot-socks', label: '鞋袜', description: '袜子、鞋履和足部服饰', categoryIds: ['character-clothing'], itemIds: FOOT_SOCKS, collectedBucket: 'socks', ...CHARACTER_NODE_RULES.socks },
      { id: 'clothing-upper', label: '上身服装', description: '旧版细分路径，保留用于已有工作流', categoryIds: ['character-clothing'], itemIds: CLOTHING_UPPER, hidden: true },
    ],
  },
  { id: 'action-expression', label: '动作与表情', description: '表情、动作、姿态和视线', categoryIds: ['character-expression', 'character-pose', 'character-action'], ...collectedNode(['面部特征', '人物动作', '方向与视线', '9_动作姿态/动态动作', '9_动作姿态/手部姿态', '9_动作姿态/站坐姿态'], ['expression', 'smile', 'laugh', 'cry', 'pose', 'standing', 'sitting', 'walking', 'holding', 'gaze', 'looking']), children: ACTION_EXPRESSION_CHILDREN.map(child => ({ ...child, ...collectedNode(child.collectedGroups, child.collectedSearchTerms) })) },
  { id: 'composition', label: '构图与镜头', description: '取景范围、视角、透视和画面布局', categoryIds: ['composition', 'subject'], ...collectedNode(['构图与镜头', '构图', '透视与视角', '画面格式', '2_构图视角/构图方式', '2_构图视角/镜头距离', '2_构图视角/视角方向'], ['composition', 'close-up', 'portrait', 'angle', 'perspective', 'framing', 'view', 'shot']), children: COMPOSITION_CHILDREN.map(child => ({ ...child, ...collectedNode(child.collectedGroups, child.collectedSearchTerms) })) },
  { id: 'scene', label: '场景与环境', description: '环境、背景、时间、天气和空间氛围', categoryIds: ['environment', 'subject'], ...collectedNode(['室内环境', '室外环境', '自然环境', '城市', '建筑', '背景', '天空天气', '7_场景背景/城市建筑', '7_场景背景/室内场景', '7_场景背景/自然场景', '7_场景背景/时间天气', '物品', '画面元素'], ['environment', 'interior', 'exterior', 'forest', 'city', 'street', 'building', 'background', 'weather', 'nature', 'object', 'prop']), children: SCENE_CHILDREN.map(child => ({ ...child, ...collectedNode(child.collectedGroups, child.collectedSearchTerms) })) },
  { id: 'lighting', label: '光线与色彩', description: '光源、色温、阴影和色彩关系', categoryIds: ['lighting'], ...collectedNode(['色彩', '视觉效果', '8_色彩光线/光照', '8_色彩光线/色调'], ['light', 'lighting', 'color', 'shadow', 'glow', 'highlight', 'contrast', 'warm', 'cool']), children: LIGHTING_CHILDREN.map(child => ({ ...child, ...collectedNode(child.collectedGroups, child.collectedSearchTerms) })) },
  { id: 'style', label: '风格与材质', description: '艺术风格、媒介和渲染方向', categoryIds: ['style'], ...collectedNode(['艺术风格', '艺术表现', '艺术风格/绘画媒介', '艺术风格/绘画风格', '艺术风格/经典流派', '艺术风格/现代潮流', '艺术风格/数字风格', '1_艺术风格/绘画风格', '1_艺术风格/经典流派', '1_艺术风格/现代潮流', '1_艺术风格/数字艺术'], ['style', 'art', 'painting', 'drawing', 'illustration', 'anime', 'cinematic', 'photography', 'render']), children: STYLE_CHILDREN.map(child => ({ ...child, ...collectedNode(child.collectedGroups, child.collectedSearchTerms) })) },
  { id: 'quality', label: '细节与质量', description: '清晰度、细节、光影和完成度', categoryIds: ['detail'], ...collectedNode(['画质', '0_画质基础/品质词', '0_画质基础/渲染效果', '视觉效果', '背景', '12_负面提示/画质缺陷', '12_负面提示/内容过滤'], ['quality', 'masterpiece', 'highres', 'sharp', 'detail', 'texture', 'depth', 'blurry', 'lowres', 'artifact']), children: QUALITY_CHILDREN.map(child => ({ ...child, ...collectedNode(child.collectedGroups, child.collectedSearchTerms) })) },
  { id: 'collected', label: '收集词库', description: '按原始标签元数据浏览的完整资料库', source: 'collected', dynamic: true },
  { id: 'favorites', label: '我的收藏', description: '收藏后随时取用', source: 'favorites' },
  { id: 'custom', label: '我的词条', description: '自己保存的完整提示词', source: 'custom' },
];

export function matchesPromptTaxonomy(item, node) {
  if (!item || !node) return false;
  if (node.source === 'curated' && (item.category === 'collected' || item.category === 'custom')) return false;
  if (node.source === 'collected' && item.category !== 'collected') return false;
  if (node.source === 'favorites') return false;
  if (node.source === 'custom') return item.category === 'custom';
  if (item.category === 'collected') {
    if (node.collectedBucket) {
      const bucket = CHARACTER_BUCKET_ORDER.find(id => matchesCollectedRule(item, CHARACTER_NODE_RULES[id]));
      if (bucket !== node.collectedBucket) return false;
    } else if (!matchesCollectedRule(item, node)) return false;
  } else if (node.categoryIds && !node.categoryIds.includes(item.category) && !node.additionalItemIds?.includes(item.id)) return false;
  if (item.category !== 'collected' && node.itemIds && !node.itemIds.includes(item.id)) return false;
  if (node.curatedTerms?.length && item.category !== 'collected' && item.category !== 'custom') {
    const text = item.searchText || `${item.title || ''}\n${item.description || ''}`.toLowerCase();
    if (!node.curatedTerms.some(term => text.includes(term))) return false;
  }
  if (node.tagGroup && (item.tagGroup || '未分类') !== node.tagGroup) return false;
  return true;
}

export function createCollectedTaxonomyGroups(items) {
  const counts = new Map();
  for (const item of items) {
    if (item.category !== 'collected' || item.kind === 'phrase') continue;
    const group = item.tagGroup || '未分类';
    counts.set(group, (counts.get(group) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tagGroup, count]) => ({
      id: `collected-group:${tagGroup}`,
      label: tagGroup.replace(/^\d+_/, ''),
      description: `${count.toLocaleString()} 条收集标签`,
      source: 'collected',
      categoryIds: ['collected'],
      tagGroup,
      count,
    }));
}
