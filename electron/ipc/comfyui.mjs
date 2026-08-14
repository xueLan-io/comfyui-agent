// ComfyUI / media IPC domain extracted from electron/main.mjs (2026-08-14):
// runtime status, root/base-url configuration, portable download, image save /
// preview. Shared helpers (image data URLs, downloadToFile, formatBytes) are
// injected through ctx so they stay owned by main.mjs.

export function registerComfyuiIpc(ctx) {
  const {
    ipcMain,
    dialog,
    shell,
    app,
    join,
    resolve,
    basename,
    existsSync,
    rename,
    copyFile,
    stat,
    writeFile,
    mkdir,
    rm,
    spawnSync,
    comfyManager,
    getComfyManager,
    getAgent,
    getPrefStore,
    getImageDataUrl,
    getAuthorizedMediaDataUrl,
    getRecentImages,
    resolveImagePath,
    normalizeHttpUrl,
    getWorkflowDir,
    getStoredConfig,
    sendToRenderer,
    downloadToFile,
    formatBytes,
    findPortableRootUnder,
    hasPortableLayout,
    ComfyUITool,
    ComfyUIClient,
    COMFYUI_PORTABLE_URLS,
    DEFAULT_BASE_URL,
    COMFY_START_DIRS,
    envConfig,
  } = ctx;

  ipcMain.handle('comfyui:status', async () => comfyManager.refreshState());
  ipcMain.handle('h3:readiness', async () => {
    const state = await comfyManager.refreshState();
    if (state.status !== 'ready') return { ready: false, message: state.message || 'ComfyUI is not ready' };
    try {
      const info = await ComfyUITool.client.objectInfo();
      const required = ['MiniMaxH3ReferenceToVideo', 'MiniMaxH3SigmaShift', 'EmptyMiniMaxH3LatentAV'];
      const missing = required.filter(name => !info?.[name]);
      return missing.length === 0
        ? { ready: true, message: 'MiniMax H3 官方节点已加载' }
        : { ready: false, message: `H3 节点未加载：${missing.join('、')}。请完成更新后重启 ComfyUI。`, missing };
    } catch (error) {
      return { ready: false, message: error.message || '无法读取 ComfyUI 节点信息' };
    }
  });

  ipcMain.handle('comfyui:start', async () => comfyManager.ensureStarted());

  ipcMain.handle('comfyui:select-root', async () => {
    const result = await dialog.showOpenDialog(getMainWindowSafe(), {
      properties: ['openDirectory'],
      defaultPath: comfyManager.portableRoot || undefined,
      title: '选择 ComfyUI 根目录（含 python_embeded 和 ComfyUI 文件夹）',
    });
    if (result.canceled || result.filePaths.length === 0) return comfyManager.getState();
    const root = result.filePaths[0];
    if (!hasPortableLayout(root)) {
      throw new Error('所选目录不是 ComfyUI portable 根目录（缺少 python_embeded\\python.exe 和 ComfyUI\\main.py）');
    }
    comfyManager.setPortableRoot(root);
    getPrefStore().set('comfyui', { ...getPrefStore().get('comfyui'), portableRoot: root });
    const agent = getAgent();
    if (agent?.isAlive) await agent.reconfigureComfy({ comfyRoot: join(root, 'ComfyUI'), workflowDir: getWorkflowDir(getStoredConfig()) });
    return comfyManager.getState();
  });

  ipcMain.handle('comfyui:set-base-url', async (_, { baseUrl = '' } = {}) => {
    const normalized = comfyManager.setBaseUrl(normalizeHttpUrl(baseUrl || DEFAULT_BASE_URL, 'ComfyUI 地址'));
    ComfyUITool.setClient(new ComfyUIClient({ baseUrl: normalized }));
    getPrefStore().set('comfyui', { ...getPrefStore().get('comfyui'), baseUrl: normalized });
    const agent = getAgent();
    if (agent?.isAlive) await agent.reconfigureComfy({ baseUrl: normalized });
    return comfyManager.refreshState();
  });

  ipcMain.handle('comfyui:reset', async () => {
    comfyManager.setBaseUrl(envConfig.COMFYUI_BASE_URL || DEFAULT_BASE_URL);
    comfyManager.redetectRoot(COMFY_START_DIRS);
    getPrefStore().set('comfyui', { baseUrl: comfyManager.baseUrl });
    ComfyUITool.setClient(new ComfyUIClient({ baseUrl: comfyManager.baseUrl }));
    const agent = getAgent();
    if (agent?.isAlive) await agent.reconfigureComfy({ baseUrl: comfyManager.baseUrl });
    return comfyManager.refreshState();
  });

  ipcMain.handle('comfyui:download-portable', async (_, { kind = 'nvidia' } = {}) => {
    const url = COMFYUI_PORTABLE_URLS[kind] || COMFYUI_PORTABLE_URLS.nvidia;
    const result = await dialog.showOpenDialog(getMainWindowSafe(), {
      properties: ['openDirectory'],
      defaultPath: comfyManager.portableRoot || undefined,
      title: '选择安装位置（将在此创建 ComfyUI_windows_portable 文件夹）',
    });
    if (result.canceled || result.filePaths.length === 0) return { cancelled: true };
    const targetDir = result.filePaths[0];
    const archivePath = join(targetDir, 'comfyui-portable.7z');
    const extractDir = join(targetDir, '.comfyui-portable-extract');
    try {
      sendToRenderer('comfyui:download-progress', { phase: 'download', percent: 0, message: '正在下载 ComfyUI portable...' });
      await downloadToFile(url, archivePath, progress => {
        const percent = progress.total ? Math.round(progress.percent * 100) : -1;
        sendToRenderer('comfyui:download-progress', {
          phase: 'download',
          percent,
          message: `已下载 ${formatBytes(progress.bytes)}${progress.total ? ` / ${formatBytes(progress.total)}` : ''}`,
        });
      });
      await rm(extractDir, { recursive: true, force: true });
      await mkdir(extractDir, { recursive: true });
      sendToRenderer('comfyui:download-progress', { phase: 'extract', percent: -1, message: '正在解压，请稍候...' });
      const extraction = spawnSync('tar', ['-xf', archivePath, '-C', extractDir], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      if (extraction.status !== 0) {
        throw new Error('解压失败：系统 tar 无法读取 7z 文件（需要 Windows 10 1803 及以上版本）');
      }
      const root = findPortableRootUnder(extractDir);
      if (!root) throw new Error('解压结果中未找到 ComfyUI 目录');
      const finalRoot = join(targetDir, basename(root));
      if (existsSync(finalRoot)) await rm(finalRoot, { recursive: true, force: true });
      await rename(root, finalRoot);
      comfyManager.setPortableRoot(finalRoot);
      getPrefStore().set('comfyui', { ...getPrefStore().get('comfyui'), portableRoot: finalRoot });
      sendToRenderer('comfyui:download-progress', { phase: 'done', message: '安装完成' });
      const state = await comfyManager.ensureStarted();
      return state;
    } finally {
      await rm(archivePath, { force: true });
      await rm(extractDir, { recursive: true, force: true });
    }
  });

  ipcMain.handle('comfyui:image-data', async (_, image) => getImageDataUrl(image));
  ipcMain.handle('media:image-data', async (_, media) => getAuthorizedMediaDataUrl(media));

  ipcMain.handle('comfyui:save-image', async (_, image) => {
    const source = resolveImagePath(image);
    const result = await dialog.showSaveDialog(getMainWindowSafe(), {
      title: '另存图片',
      defaultPath: image.filename,
    });
    if (result.canceled || !result.filePath) return { saved: false };
    if (resolve(result.filePath) !== source) await copyFile(source, result.filePath);
    return { saved: true, path: result.filePath };
  });

  ipcMain.handle('comfyui:show-image', async (_, image) => {
    const filePath = resolveImagePath(image);
    await stat(filePath);
    shell.showItemInFolder(filePath);
    return { shown: true };
  });

  ipcMain.handle('app:save-text-file', async (_, { defaultName = 'export.txt', content = '', filterName = '文本文件' } = {}) => {
    const result = await dialog.showSaveDialog(getMainWindowSafe(), {
      title: '导出文件',
      defaultPath: defaultName,
      filters: [{ name: filterName, extensions: [defaultName.split('.').pop() || 'txt'] }],
    });
    if (result.canceled || !result.filePath) return { saved: false };
    await writeFile(result.filePath, content, 'utf8');
    return { saved: true, path: result.filePath };
  });

  ipcMain.handle('comfyui:recent-images', async () => getRecentImages());

  function getMainWindowSafe() {
    return ctx.getMainWindow?.() || null;
  }
}
