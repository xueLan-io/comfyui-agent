const POLICY_TRANSITIONS = {
  idle: ['reviewing'],
  reviewing: ['cloud_allowed', 'local_fallback'],
  cloud_allowed: ['idle', 'local_fallback'],
  local_fallback: ['idle', 'blocked'],
  blocked: ['idle'],
};

const EXPLICIT_SEXUAL = /(?:\b(?:nsfw|xxx|porn(?:ography)?|nude|naked|nudity|genitals?|penis|vagina|pussy|masturbat\w*|vibrator|sex scene|blowjob|handjob|hardcore|anal|fuck(?:ing)?|orgasm|cum)\b|色情|性交|性爱|做爱|裸体|裸照|自慰|手淫|口交|乳交|阴部|阴茎|阴道|生殖器|性器官|射精|内射|颜射|群交|兽交)/i;

const SOFT_SEXUAL = [
  /\b(?:erotic|erotica|lustful|seductive|see[- ]through|bare body|bare breasts|bondage|shibari|dominatrix|lingerie)\b/gi,
  /情趣|束缚|裸露|挑逗|诱惑|露骨|半裸|若隐若现/gi,
];

function softSexualHits(text = '') {
  let count = 0;
  for (const pattern of SOFT_SEXUAL) {
    for (const match of String(text).matchAll(pattern)) {
      count += 1;
      if (count >= 2) return count;
    }
  }
  return count;
}

const GRAPHIC_VIOLENCE = /(?:\b(?:gore|graphic violence|dismember\w*|decapitat\w*|torture|blood splatter|bloodbath)\b|血腥|肢解|斩首|酷刑|屠杀|碎尸|开膛破肚)/i;
const SELF_HARM = /(?:\b(?:suicide|suicidal|self[- ]harm|kill myself|end my life)\b|自杀|自残|轻生)/i;
const ILLICIT_INSTRUCTIONS = /(?:\b(?:how to (?:make|build|deploy) (?:a )?(?:bomb|weapon|malware)|make (?:a )?bomb|deploy malware|steal credentials|bypass authentication|break into)\b|炸弹制作|制作武器|部署木马|窃取密码|绕过认证|入侵系统)/i;

const POLICY_RULES = [
  { category: 'sexual_content', test: text => EXPLICIT_SEXUAL.test(text) || softSexualHits(text) >= 2 },
  { category: 'sexualized_minors', test: text => SEXUALIZED_MINORS.test(text) },
  { category: 'graphic_violence', test: text => GRAPHIC_VIOLENCE.test(text) },
  { category: 'self_harm', test: text => SELF_HARM.test(text) },
  { category: 'illicit_instructions', test: text => ILLICIT_INSTRUCTIONS.test(text) },
];

const DIRECT_MINORS = /(?:child porn|kiddie porn|\bcsam\b|child sexual abuse|儿童色情|恋童|萝莉控|幼女色情|未成年色情)/i;
const MINOR_SIGNAL = /(?:\b(?:child|minor|underage|loli|lolita|schoolgirl)\b|儿童|未成年|幼女|萝莉|小女孩|小学生|(?<!\d)(?:[0-9]|1[0-7])\s*(?:岁|years?\s*old|yo)(?!\d))/i;
const MINOR_SEXUAL = /(?:\b(?:sex(?:ual)?|nude|naked|porn|erotic|explicit|fetish|pussy|genitals?|penis|vagina|masturbat\w*)\b|色情|裸体|裸露|自慰|性交|性爱|性侵|性虐|性行为|幼奸|猥亵|恋童|阴部|乳房|乳交|生殖器)/i;
const SEXUALIZED_MINORS = new RegExp(`(?:${DIRECT_MINORS.source}|${MINOR_SIGNAL.source}[\\s\\S]{0,48}${MINOR_SEXUAL.source}|${MINOR_SEXUAL.source}[\\s\\S]{0,48}${MINOR_SIGNAL.source})`, 'i');

function textParts(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap(part => {
    if (typeof part === 'string') return [part];
    if (part?.type === 'text') return [String(part.text || '')];
    return [];
  });
}

function collectRequestContent(messages = []) {
  let hasMedia = false;
  const text = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === 'system') continue;
    text.push(...textParts(message?.content));
    if (Array.isArray(message?.content) && message.content.some(part => part?.type === 'image_url' || part?.type === 'image')) {
      hasMedia = true;
    }
  }
  return { text: text.join('\n'), hasMedia };
}

export class CloudPolicyBlockedError extends Error {
  constructor(message, decision) {
    super(message);
    this.name = 'CloudPolicyBlockedError';
    this.code = 'CLOUD_POLICY_BLOCKED';
    this.policyDecision = decision;
  }
}

export class CloudPolicyRouter {
  constructor({ onStateChange } = {}) {
    this.state = 'idle';
    this.onStateChange = onStateChange;
  }

  setStateHandler(onStateChange) {
    this.onStateChange = onStateChange;
  }

  _transition(next, details = {}) {
    if (!POLICY_TRANSITIONS[this.state]?.includes(next)) {
      throw new Error(`Invalid cloud policy state transition: ${this.state} -> ${next}`);
    }
    this.state = next;
    this.onStateChange?.({ state: next, ...details });
  }

  review(messages = []) {
    this._transition('reviewing');
    const { text, hasMedia } = collectRequestContent(messages);

    const categories = POLICY_RULES
      .filter(rule => rule.test(text))
      .map(rule => rule.category);
    const decision = {
      allowed: categories.length === 0 && !hasMedia,
      requiresLocal: categories.length > 0 || hasMedia,
      categories,
      reason: hasMedia ? 'unreviewed_media' : categories.length > 0 ? 'restricted_content' : '',
    };
    this._transition(decision.requiresLocal ? 'local_fallback' : 'cloud_allowed', {
      categories: decision.categories,
      reason: decision.reason,
    });
    return decision;
  }

  complete() {
    if (this.state === 'cloud_allowed' || this.state === 'local_fallback' || this.state === 'blocked') {
      this._transition('idle');
    }
  }

  useLocal(details = {}) {
    if (this.state === 'cloud_allowed') this._transition('local_fallback', details);
  }

  block(decision) {
    if (this.state === 'local_fallback') this._transition('blocked', { categories: decision.categories, reason: decision.reason });
  }
}

export function reviewCloudMessages(messages = []) {
  const router = new CloudPolicyRouter();
  return router.review(messages);
}
