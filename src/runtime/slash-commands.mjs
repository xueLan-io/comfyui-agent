const COMMANDS = [
  { id: 'help', aliases: ['帮助', '?'], description: '查看可用命令、快捷键和已启用技能', action: 'help' },
  { id: 'shortcuts', aliases: ['快捷键'], description: '查看快捷键和斜杠命令', action: 'shortcuts' },
  { id: 'skills', aliases: ['技能'], description: '查看当前可用技能', action: 'skills' },
  { id: 'compact', aliases: ['压缩', '整理上下文'], description: '归档较早对话，释放上下文', action: 'compact' },
  { id: 'context', aliases: ['上下文'], description: '查看上下文占用和归档情况', action: 'context' },
  { id: 'new', aliases: ['新对话'], description: '在当前项目中新建会话', action: 'new' },
  { id: 'clear', aliases: ['清空'], description: '清空当前会话记录', action: 'clear' },
  { id: 'stop', aliases: ['停止', '取消'], description: '停止当前任务', action: 'stop' },
  { id: 'status', aliases: ['状态'], description: '查看模型、工作流和运行状态', action: 'status' },
];

function normalized(value = '') {
  return String(value).trim().toLowerCase();
}

export function commandCatalog(skills = []) {
  const builtins = COMMANDS.map(command => ({ ...command, label: `/${command.id}`, type: 'command' }));
  const skillCommands = skills.filter(skill => skill.enabled !== false).map(skill => ({
    id: skill.id,
    aliases: skill.aliases || [],
    description: skill.description || skill.name || skill.id,
    label: `/${skill.id}`,
    type: 'skill',
    skill,
  }));
  return [...builtins, ...skillCommands];
}

export function parseSlashCommand(value, skills = []) {
  const match = String(value).match(/^\/([^\s]*)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const [, rawName = '', argument = ''] = match;
  const name = normalized(rawName);
  if (!name) return { query: '', argument: '', command: null };
  const command = commandCatalog(skills).find(item => normalized(item.id) === name || item.aliases.some(alias => normalized(alias) === name)) || null;
  return { query: rawName, argument, command };
}

export function matchingSlashCommands(value, skills = []) {
  const parsed = parseSlashCommand(value, skills);
  if (!parsed || String(value).includes(' ')) return [];
  const query = normalized(parsed.query);
  return commandCatalog(skills).filter(item => !query || normalized(item.id).includes(query) || item.aliases.some(alias => normalized(alias).includes(query))).slice(0, 10);
}
