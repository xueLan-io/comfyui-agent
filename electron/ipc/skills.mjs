// Skills IPC domain extracted from electron/main.mjs (2026-08-14): built-in /
// custom / external skill registry and lifecycle. Depends on the preferences
// store (prefStore), the shared configureSkills hook, dialog for file import,
// and the main window reference.

export function registerSkillsIpc(ctx) {
  const {
    ipcMain,
    prefStore,
    configureSkills,
    skillManifest,
    BUILTIN_SKILLS,
    createCustomSkill,
    normalizeExternalSkill,
    externalSkillConfig,
    loadExternalSkillFile,
    dialog,
    getMainWindow,
  } = ctx;

  ipcMain.handle('skills:list', async () => {
    const skills = prefStore.get('skills') || {};
    const external = Object.fromEntries((skills.external || []).filter(item => item?.id && item.enabled !== false).map(item => {
      try { return [item.id, normalizeExternalSkill(item, item.source || 'config')]; } catch { return null; }
    }).filter(Boolean));
    const custom = Object.fromEntries((skills.custom || []).filter(item => item?.id && item.enabled !== false).map(item => [item.id, createCustomSkill(item)]));
    return { ...skills, registry: [...skillManifest(BUILTIN_SKILLS, skills.system), ...skillManifest(custom), ...skillManifest(external)] };
  });

  ipcMain.handle('skills:set-enabled', async (_, { id, enabled, custom = false, external = false }) => {
    const skills = prefStore.get('skills');
    if (external) {
      const skill = skills.external.find(item => item.id === id);
      if (!skill) throw new Error('外部 Skill 不存在');
      skill.enabled = Boolean(enabled);
    } else if (custom) {
      const skill = skills.custom.find(item => item.id === id);
      if (!skill) throw new Error('技能不存在');
      skill.enabled = Boolean(enabled);
    } else {
      if (!(id in BUILTIN_SKILLS)) throw new Error('系统技能不存在');
      skills.system[id] = Boolean(enabled);
    }
    prefStore.set('skills', skills);
    configureSkills({ systemEnabled: skills.system, custom: skills.custom, external: skills.external });
    return skills;
  });

  ipcMain.handle('skills:add-custom', async (_, { skill }) => {
    if (!/^[a-z0-9_-]+$/.test(skill?.id || '')) throw new Error('技能 ID 格式无效');
    const skills = prefStore.get('skills');
    if (skills.custom.some(item => item.id === skill.id) || skill.id in skills.system) throw new Error('技能 ID 已存在');
    skills.custom.push({ ...skill, keywords: Array.isArray(skill.keywords) ? skill.keywords : [], enabled: skill.enabled !== false });
    prefStore.set('skills', skills);
    configureSkills({ systemEnabled: skills.system, custom: skills.custom, external: skills.external });
    return skills;
  });

  ipcMain.handle('skills:delete-custom', async (_, { id }) => {
    const skills = prefStore.get('skills');
    skills.custom = skills.custom.filter(item => item.id !== id);
    prefStore.set('skills', skills);
    configureSkills({ systemEnabled: skills.system, custom: skills.custom, external: skills.external });
    return skills;
  });

  ipcMain.handle('skills:import-external', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'External Skill manifest', extensions: ['json'] }],
      title: '导入外部 Skill（声明式 JSON）',
    });
    if (result.canceled || result.filePaths.length === 0) return prefStore.get('skills');
    const skills = prefStore.get('skills');
    const imported = [];
    for (const filePath of result.filePaths) {
      const skill = await loadExternalSkillFile(filePath);
      if (skills.system[skill.id] || skills.custom.some(item => item.id === skill.id) || skills.external.some(item => item.id === skill.id)) throw new Error(`Skill ID 已存在：${skill.id}`);
      imported.push(skill);
    }
    skills.external.push(...imported.map(externalSkillConfig));
    prefStore.set('skills', skills);
    configureSkills({ systemEnabled: skills.system, custom: skills.custom, external: skills.external });
    return skills;
  });

  ipcMain.handle('skills:delete-external', async (_, { id }) => {
    const skills = prefStore.get('skills');
    skills.external = skills.external.filter(item => item.id !== id);
    prefStore.set('skills', skills);
    configureSkills({ systemEnabled: skills.system, custom: skills.custom, external: skills.external });
    return skills;
  });

  // Create an external (declarative) skill from form fields instead of a JSON
  // file: validates through the same normalize/validate path as file import.
  ipcMain.handle('skills:add-external', async (_, input = {}) => {
    const skill = normalizeExternalSkill(input, 'form');
    const skills = prefStore.get('skills');
    if (skills.system[skill.id] || skills.custom.some(item => item.id === skill.id) || skills.external.some(item => item.id === skill.id)) {
      throw new Error(`Skill ID 已存在：${skill.id}`);
    }
    skills.external.push(externalSkillConfig(skill));
    prefStore.set('skills', skills);
    configureSkills({ systemEnabled: skills.system, custom: skills.custom, external: skills.external });
    return skills;
  });
}
