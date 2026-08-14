// Anima / Miaomiao 出图规范（单点事实来源）。
// 沉淀用户确认过的通用基线、标签块顺序、权重语法、画师候选与构图模板。
// 被 enhance.mjs 的 Anima 编译分支引用；也可以被未来的「场景选择 / 模板库」UI 复用。

// 通用正向质量/安全基线（全部 Anima 出图共用，放在标签块最前面）。
export const ANIME_QUALITY_BASELINE = 'best quality, very aesthetic, ultra detailed, sensitive, masterpiece, score_9, score_8, score_7, absurd res, official art';

// 通用负向基线（全部 Anima 出图共用）。
export const ANIME_NEGATIVE_BASELINE = 'worst quality, low quality, score_1, score_2, score_3, artist name, shiny skin, bad anatomy, bad hands, extra fingers, missing fingers, deformed hands, malformed limbs, blurred, blurry, watermark, text, signature, logo, jpeg artifacts, lowres, oversaturated';

// 标签块顺序（质量/安全基线之后）。
export const ANIME_TAG_ORDER = ['quality', 'safety', 'subjectCount', 'character', 'series', 'artist', 'general'];

// 画师 token：@4x0style 已确认；其余为候选，需同提示词 + 不同种子实测。
export const ANIME_ARTIST_CONFIRMED = ['@4x0style'];
export const ANIME_ARTIST_CANDIDATES = ['@lack', 'guweiz', 'wlop', 'neco', 'redjuice', 'kawacy'];

// 语法与采样约定（供编译器与说明文档参考）。
export const ANIME_WEIGHT_RULE = '强调用 (word:2.0) 这一种写法，括号不转义；不用 (attr:1.2)、((word)) 或下划线；多词标签用空格（如 absurd res）。';
export const ANIME_SAMPLER_RULE = 'Euler a / 30 步 / CFG 4–5（工作流侧设置）。';
export const ANIME_IMG2IMG_DENOISE = '0.4–0.6';

// 构图模板库。tags 为质量/安全基线之后的英文标签块；narrative 为按八维顺序展开的自然语言正文示范。
export const ANIME_SCENE_TEMPLATES = [
  {
    id: 'halfbody-portrait',
    label: '单人半身肖像',
    shot: 'medium close-up / upper body',
    subjectCount: 'solo, 1girl',
    artist: '@4x0style',
    tags: 'long silver hair, blue eyes, white blouse, upper body, portrait, soft lighting, plain background',
    narrative: 'A young woman in her early twenties with long silver hair and gentle blue eyes, wearing a crisp white blouse, in a relaxed half-body pose with one hand at her collar; medium close-up from a slightly elevated angle against a plain studio background, soft diffused window light, calm and intimate mood, polished anime illustration with clean linework and fine hair and fabric detail.',
  },
  {
    id: 'fullbody-sheet',
    label: '全身角色设定',
    shot: 'full body / eye level',
    subjectCount: 'solo, 1girl',
    artist: '@4x0style',
    tags: 'long chestnut brown hair, green eyes, school uniform, pleated skirt, knee socks, full body, standing pose, simple solid white background, soft cel shading',
    narrative: 'A high school girl with long chestnut brown hair in a side braid and bright green eyes, navy school uniform with white sailor collar, pleated skirt, knee socks and loafers; full-body composition straight ahead at eye level against a plain white studio backdrop with a soft drop shadow, even shadowless lighting, bright and wholesome mood, soft cel shading with gentle pastel tones.',
  },
  {
    id: 'two-person',
    label: '双人互动',
    shot: 'medium / waist up, three-quarter angle',
    subjectCount: '2girls',
    artist: '@4x0style',
    tags: 'short black hair, red eyes, long blonde hair, blue eyes, casual clothes, cheerful, warm sunlight, garden background',
    narrative: 'Two girls sitting close together on a garden bench, one with short black hair and red eyes in a loose cream hoodie, the other with long blonde hair and blue eyes in a floral summer dress, shoulders touching, laughing and smiling; medium waist-up shot from a slight three-quarter angle, quiet garden with layered hedges and a stone path, warm afternoon sunlight casting dappled golden highlights, warm and carefree mood, polished anime illustration.',
  },
  {
    id: 'neon-rain-night',
    label: '雨夜霓虹场景',
    shot: 'full body / street level, figure in lower third',
    subjectCount: 'solo, 1girl',
    artist: '@4x0style',
    tags: 'dark blue hair, purple eyes, long coat, night city street, neon lights, cinematic lighting, rain, wet reflective pavement, full body, (looking at viewer:2.0)',
    narrative: 'A quiet young woman with dark blue hair in a low ponytail and luminous purple eyes meeting the viewer, long dark wool coat over a black turtleneck, standing on a rainy night street with one hand in her pocket; full-body street-level shot with the figure in the lower third, neon shop signs casting cyan and magenta reflections on wet pavement, cinematic high-contrast rim light, melancholic and atmospheric mood, fine rain streaks and rich controlled color.',
  },
  {
    id: 'fantasy-knight',
    label: '奇幻原创造型·骑士',
    shot: 'full body / low angle',
    subjectCount: 'solo, 1girl',
    artist: '@lack',
    tags: 'white hair, amber eyes, fantasy armor, sword, cape, full body, dramatic sky background, concept art',
    narrative: 'A young knight with waist-length white hair braided at the sides and steady amber eyes, layered silver fantasy armor with filigree, a flowing crimson cape and a sheathed sword at her hip; confident grounded stance with one hand on the sword hilt, low-angle full-body composition against a vast stormy sky over rocky highland, warm rim light against a cold blue-gray sky, epic and heroic concept-art mood with painterly brushwork and metallic detail.',
  },
  {
    id: 'img2img-base',
    label: '图生图 / 重绘基座',
    shot: 'medium close-up / eye level',
    subjectCount: 'solo, 1girl',
    artist: '@4x0style',
    tags: 'long silver hair, blue eyes, white blouse, upper body, portrait, soft lighting, plain background',
    denoise: ANIME_IMG2IMG_DENOISE,
    narrative: 'Keep the face, hairstyle and outfit identical to the reference image with no change to identity or expression; relaxed three-quarter upper-body pose, one hand lightly at the collar, gentle gaze toward camera; preserve the original framing and headroom, clean softly blurred background, soft even lighting that refines skin and fabric without shifting the color scheme; faithful refined anime illustration ready for light touch-up or restyle.',
  },
];

// 构图模板清单（供编译器注入的精简版，只带标签与景别，避免撑爆提示词）。
export function animeSceneSummary() {
  return ANIME_SCENE_TEMPLATES.map(template => template.label + '（' + template.shot + '）').join('、');
}
