// Global presets IPC domain extracted from electron/main.mjs (2026-08-14):
// preset CRUD, covers, dependency checks, import/export ZIP. Depends on the
// shared preset root (owned here), image-path resolution, workflow listing and
// the ComfyUI model tree for dependency checks.

import { join } from 'path';

export function getPresetsRoot(app) {
  return join(app.getPath('userData'), 'global-presets');
}

export function registerPresetsIpc(ctx) {
  const {
    ipcMain,
    app,
    join,
    resolve,
    basename,
    extname,
    readFile,
    readdir,
    writeFile,
    copyFile,
    mkdir,
    mkdtemp,
    rm,
    existsSync,
    statSync,
    spawnSync,
    dialog,
    getMainWindow,
    getAgent,
    getWorkflowDir,
    listWorkflowFiles,
    resolveImagePath,
    getComfyManager,
    listGlobalPresets,
    createGlobalPreset,
    updateGlobalPreset,
    deleteGlobalPreset,
    copyGlobalPreset,
    markPresetUsed,
    rateGlobalPreset,
    composeGlobalPresets,
    replacePresetModel,
    copyPresetCover,
    importGlobalPreset,
    FORMAT,
    VERSION,
    assertInside,
  } = ctx;

  let globalPresetsRoot = '';

  function presetRoot() {
    if (!globalPresetsRoot) globalPresetsRoot = join(app.getPath('userData'), 'global-presets');
    return globalPresetsRoot;
  }

  async function selectPresetFile(title, filters, properties = ['openFile']) {
    const dialogMethod = properties.includes('showSaveDialog') ? 'showSaveDialog' : 'showOpenDialog';
    const normalizedProperties = properties.filter(value => value !== 'showSaveDialog');
    const result = await dialog[dialogMethod](getMainWindow(), { properties: normalizedProperties, title, filters });
    return result.canceled ? '' : result.filePaths[0] || '';
  }

  function resolvePresetInput(input = {}) {
    const sourceRefs = Array.isArray(input.sourceRefs) ? input.sourceRefs : [];
    const resultRefs = Array.isArray(input.resultRefs) ? input.resultRefs : [];
    const resolveRefs = refs => refs.map(ref => {
      try { return resolveImagePath(ref); }
      catch (error) { throw new Error(`无法访问预设资源：${ref?.filename || ref?.name || '未知文件'}（${error.message}）`); }
    });
    const resolved = {
      ...input,
    };
    const agent = getAgent();
    if (input.workflowSourcePath || input.workflow) resolved.workflowSourcePath = input.workflowSourcePath || (agent?.workflowDir ? resolve(agent.workflowDir, input.workflow) : '');
    if (Array.isArray(input.sourcePaths) || sourceRefs.length) resolved.sourcePaths = [...(Array.isArray(input.sourcePaths) ? input.sourcePaths : []), ...resolveRefs(sourceRefs)];
    if (Array.isArray(input.resultPaths) || resultRefs.length) resolved.resultPaths = [...(Array.isArray(input.resultPaths) ? input.resultPaths : []), ...resolveRefs(resultRefs)];
    if (input.coverSourcePath || input.coverRef) resolved.coverSourcePath = input.coverSourcePath || resolveRefs([input.coverRef])[0];
    return resolved;
  }

  ipcMain.handle('global-presets:list', async () => listGlobalPresets(presetRoot()));
  ipcMain.handle('global-presets:delete', async (_, { id } = {}) => deleteGlobalPreset(presetRoot(), id));
  ipcMain.handle('global-presets:copy', async (_, { id } = {}) => copyGlobalPreset(presetRoot(), id));
  ipcMain.handle('global-presets:mark-used', async (_, { id, generated = false } = {}) => markPresetUsed(presetRoot(), id, generated));
  ipcMain.handle('global-presets:rate', async (_, { id, rating } = {}) => rateGlobalPreset(presetRoot(), id, rating));
  ipcMain.handle('global-presets:replace-model', async (_, { id, from, to } = {}) => replacePresetModel(presetRoot(), id, from, to));
  ipcMain.handle('global-presets:compose', async (_, { ids = [], title = '' } = {}) => composeGlobalPresets(presetRoot(), ids, { title }));
  ipcMain.handle('global-presets:match-workflow', async (_, { workflowName = '' } = {}) => {
    const agent = getAgent();
    const dir = getWorkflowDir({ workflowDir: agent?.workflowDir });
    const files = await Promise.resolve(listWorkflowFiles(dir)).catch(() => []);
    const names = (files || []).map(item => typeof item === 'string' ? item : item.name).filter(Boolean);
    if (!workflowName) return { workflowName: '', candidates: names.slice(0, 20) };
    const exact = names.find(name => name === workflowName);
    if (exact) return { workflowName: exact, matched: true, candidates: [exact] };
    const stem = workflowName.replace(/\.json$/i, '').toLowerCase();
    const candidates = names.filter(name => name.toLowerCase().includes(stem)).slice(0, 10);
    return { workflowName: candidates[0] || '', matched: Boolean(candidates[0]), candidates };
  });

  ipcMain.handle('global-presets:create', async (_, input = {}) => createGlobalPreset(presetRoot(), resolvePresetInput(input)));
  ipcMain.handle('global-presets:update', async (_, { id, patch = {} } = {}) => updateGlobalPreset(presetRoot(), id, resolvePresetInput(patch)));
  ipcMain.handle('global-presets:select-cover', async () => selectPresetFile('选择预设封面', [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]));
  ipcMain.handle('global-presets:select-import', async () => selectPresetFile('导入预设', [{ name: '预设文件', extensions: ['json', 'zip'] }]));
  ipcMain.handle('global-presets:copy-cover', async (_, { id, sourcePath } = {}) => copyPresetCover(presetRoot(), id, sourcePath));
  ipcMain.handle('global-presets:image-data', async (_, cover = {}) => {
    if (!cover.path) return '';
    const root = resolve(presetRoot());
    let file;
    try { file = assertInside(root, resolve(root, cover.path)); } catch { return ''; }
    try { const data = await readFile(file); const mime = extname(file).toLowerCase() === '.jpg' || extname(file).toLowerCase() === '.jpeg' ? 'image/jpeg' : `image/${extname(file).slice(1)}`; return `data:${mime};base64,${data.toString('base64')}`; } catch { return ''; }
  });
  ipcMain.handle('global-presets:resolve-resources', async (_, { preset = {} } = {}) => {
    const root = resolve(presetRoot());
    const resolveStored = ref => {
      const path = typeof ref === 'string' ? ref : ref?.path;
      if (!path) return null;
      try {
        const file = assertInside(root, resolve(root, path));
        return { path: file, name: basename(file), kind: 'image' };
      } catch { return null; }
    };
    return {
      sourceImages: (preset.sourceImages || []).map(resolveStored).filter(Boolean),
      workflow: preset.workflow || '',
    };
  });
  ipcMain.handle('global-presets:check-dependencies', async (_, { id } = {}) => {
    const root = resolve(presetRoot());
    const presets = await listGlobalPresets(root);
    const preset = presets.find(item => item.id === id);
    if (!preset) return { presetId: id || '', valid: false, issues: [{ code: 'preset_not_found', severity: 'error', message: '预设不存在' }] };
    const issues = [];
    const checkFile = (ref, code, label, required = true) => {
      const path = typeof ref === 'string' ? ref : ref?.path;
      if (!path) {
        if (required) issues.push({ code, severity: 'error', message: `${label}未配置` });
        return { path: '', exists: false, required };
      }
      try {
        const file = assertInside(root, resolve(root, path));
        const exists = existsSync(file) && statSync(file).isFile();
        if (!exists) issues.push({ code, severity: required ? 'error' : 'warning', message: `${label}不存在：${basename(file)}` });
        return { path, exists, required };
      } catch {
        issues.push({ code: `${code}_invalid`, severity: 'error', message: `${label}路径无效` });
        return { path, exists: false, required };
      }
    };
    // A preset may intentionally inherit the currently selected workflow.
    const workflow = checkFile(preset.workflow, 'workflow_missing', '工作流', false);
    const sourceImages = (preset.sourceImages || []).map(item => checkFile(item, 'source_missing', '参考素材'));
    const resultImages = (preset.resultImages || []).map(item => checkFile(item, 'result_missing', '结果素材', false));
    const cover = preset.cover ? checkFile(preset.cover, 'cover_missing', '封面', false) : { path: '', exists: true, required: false };
    if (workflow.exists) {
      try { JSON.parse(await readFile(assertInside(root, resolve(root, workflow.path)), 'utf8')); }
      catch { issues.push({ code: 'workflow_invalid', severity: 'error', message: '工作流不是有效 JSON' }); }
    }
    const modelRequirements = Array.isArray(preset.modelRequirements) ? preset.modelRequirements : [];
    const comfyManager = getComfyManager();
    const modelRoot = comfyManager.portableRoot ? join(comfyManager.portableRoot, 'ComfyUI', 'models') : '';
    const modelFiles = [];
    async function collectModels(dir, prefix = '') {
      if (!dir || !existsSync(dir)) return;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await collectModels(full, `${prefix}${entry.name}/`);
        else modelFiles.push(`${prefix}${entry.name}`);
      }
    }
    await collectModels(modelRoot).catch(() => {});
    const missingModels = modelRequirements.filter(item => item?.available === false || !item?.value).map(item => {
      const value = item.value || '未命名模型';
      const needle = basename(value).toLowerCase();
      const candidates = modelFiles.filter(file => file.toLowerCase().includes(needle) || needle.includes(basename(file).toLowerCase())).slice(0, 5);
      return { kind: item.kind || 'model', value, candidates };
    });
    missingModels.forEach(item => issues.push({ code: 'model_missing', severity: 'error', message: `缺失模型：${item.value}` }));
    return {
      presetId: preset.id,
      valid: !issues.some(issue => issue.severity === 'error'),
      dependencies: { workflow, sourceImages, resultImages, cover, sourceCount: sourceImages.length, missingSourceCount: sourceImages.filter(item => !item.exists).length, modelRequirements, missingModels },
      issues,
    };
  });
  ipcMain.handle('global-presets:import', async (_, { sourcePath } = {}) => {
    const extractZip = async zipPath => {
      const temp = await mkdtemp(join(app.getPath('temp'), 'comfy-agent-preset-'));
      try {
        const command = `Expand-Archive -LiteralPath '${zipPath.replaceAll("'", "''")}' -DestinationPath '${temp.replaceAll("'", "''")}' -Force`;
        const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
        if (result.status !== 0) throw new Error('无法解压预设压缩包');
        const found = [];
        async function walk(dir) {
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) await walk(path); else found.push(path);
          }
        }
        await walk(temp);
        return { files: found, cleanup: () => rm(temp, { recursive: true, force: true }) };
      } finally {
        // importGlobalPreset owns cleanup after it has copied the resources.
      }
    };
    return importGlobalPreset(presetRoot(), sourcePath, extractZip);
  });
  ipcMain.handle('global-presets:export', async (_, { id } = {}) => {
    const preset = (await listGlobalPresets(presetRoot())).find(item => item.id === id);
    if (!preset) throw new Error('预设不存在');
    const target = await selectPresetFile('导出预设文件到', [{ name: 'ZIP', extensions: ['zip'] }], ['showSaveDialog']);
    if (!target) return null;
    const output = target.replace(/\.zip$/i, '') + '.zip';
    const temp = await mkdtemp(join(app.getPath('temp'), 'comfy-agent-preset-export-'));
    try {
      const packageRoot = join(temp, 'preset');
      await mkdir(packageRoot, { recursive: true });
      const sourceImages = [];
      for (const [index, image] of (preset.sourceImages || []).entries()) {
        const source = typeof image === 'string' ? image : image.path;
        const sourceFile = resolve(presetRoot(), source);
        assertInside(presetRoot(), sourceFile);
        const name = `reference-${String(index + 1).padStart(3, '0')}${extname(sourceFile).toLowerCase()}`;
        await mkdir(join(packageRoot, 'sources'), { recursive: true });
        await copyFile(sourceFile, join(packageRoot, 'sources', name));
        sourceImages.push(`sources/${name}`);
      }
      const resultImages = [];
      for (const [index, image] of (preset.resultImages || []).entries()) {
        const source = typeof image === 'string' ? image : image.path;
        const sourceFile = resolve(presetRoot(), source);
        assertInside(presetRoot(), sourceFile);
        const name = `image-${String(index + 1).padStart(3, '0')}${extname(sourceFile).toLowerCase()}`;
        await mkdir(join(packageRoot, 'results'), { recursive: true });
        await copyFile(sourceFile, join(packageRoot, 'results', name));
        resultImages.push(`results/${name}`);
      }
      let cover = '';
      if (preset.cover?.path) {
        const sourceFile = assertInside(presetRoot(), resolve(presetRoot(), preset.cover.path));
        const name = `cover${extname(sourceFile).toLowerCase()}`;
        await copyFile(sourceFile, join(packageRoot, name));
        cover = name;
      }
      let workflow = '';
      if (preset.workflow) {
        const sourceFile = assertInside(presetRoot(), resolve(presetRoot(), preset.workflow));
        workflow = 'workflow.json';
        await copyFile(sourceFile, join(packageRoot, workflow));
      }
      const portable = { format: FORMAT, version: VERSION, ...preset, cover, workflow, sourceImages, resultImages };
      await writeFile(join(packageRoot, 'preset.json'), JSON.stringify(portable, null, 2), 'utf8');
      const command = `Compress-Archive -Path '${packageRoot.replaceAll("'", "''")}${'\\*'}' -DestinationPath '${output.replaceAll("'", "''")}' -Force`;
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error('无法导出预设压缩包');
      return output;
    } finally {
      await rm(temp, { recursive: true, force: true }).catch(() => {});
    }
  });
}
