// Workflow / media-file IPC domain extracted from electron/main.mjs
// (2026-08-14): workflow listing/delete/rename/import, media file selection,
// and clipboard image save/write. Shared workflow-dir resolution and the
// authorized-media registry are injected through ctx.

export function registerWorkflowsIpc(ctx) {
  const {
    ipcMain,
    dialog,
    shell,
    app,
    join,
    basename,
    extname,
    stat,
    writeFile,
    nativeImage,
    clipboard,
    getWorkflowDir,
    getDisplayPath,
    listWorkflowFiles,
    deleteWorkflowFile,
    renameWorkflowFile,
    importWorkflowFiles,
    resolveSandboxPath,
    getAgent,
    getDirectService,
    getPrefStore,
    getAuthorizedMediaPaths,
  } = ctx;

  ipcMain.handle('list-workflows', async () => {
    const agent = getAgent();
    const dir = getWorkflowDir({ workflowDir: agent?.workflowDir });
    if (agent && dir !== agent.workflowDir) await agent.setWorkflowDir(dir);
    getDirectService()?.setWorkflowDir(dir);
    return { dir, displayDir: getDisplayPath(dir), files: listWorkflowFiles(dir) };
  });

  ipcMain.handle('workflow:delete', async (_, { name } = {}) => {
    const agent = getAgent();
    const dir = getWorkflowDir({ workflowDir: agent?.workflowDir });
    if (!dir) throw new Error('工作流目录不存在');
    const result = await deleteWorkflowFile(name, dir);
    return { dir, displayDir: getDisplayPath(dir), ...result };
  });

  ipcMain.handle('workflow:rename', async (_, { name, nextName } = {}) => {
    const agent = getAgent();
    const dir = getWorkflowDir({ workflowDir: agent?.workflowDir });
    if (!dir) throw new Error('工作流目录不存在');
    const result = await renameWorkflowFile(name, nextName, dir);
    return { dir, displayDir: getDisplayPath(dir), ...result };
  });

  ipcMain.handle('select-workflow-dir', async () => {
    const agent = getAgent();
    const result = await dialog.showOpenDialog(ctx.getMainWindow?.(), {
      properties: ['openDirectory'],
      defaultPath: getWorkflowDir({ workflowDir: agent?.workflowDir }),
      title: '选择工作流目录',
    });
    if (!result.canceled && result.filePaths.length > 0) {
      const dir = result.filePaths[0];
      getPrefStore().set('workflowDir', dir);
      if (agent) await agent.setWorkflowDir(dir);
      getDirectService()?.setWorkflowDir(dir);
      return { dir, displayDir: getDisplayPath(dir), files: listWorkflowFiles(dir) };
    }
    return null;
  });

  ipcMain.handle('show-workflow-dir', async (_, { workflowName = '' } = {}) => {
    const agent = getAgent();
    const dir = getWorkflowDir({ workflowDir: agent?.workflowDir });
    if (!dir) throw new Error('工作流目录不存在');
    if (workflowName) {
      const filePath = resolveSandboxPath({ workflowDir: dir }, workflowName);
      await stat(filePath);
      shell.showItemInFolder(filePath);
    } else {
      await shell.openPath(dir);
    }
    return { dir };
  });

  ipcMain.handle('select-workflow-files', async () => {
    const agent = getAgent();
    const result = await dialog.showOpenDialog(ctx.getMainWindow?.(), {
      properties: ['openFile', 'multiSelections'],
      title: '导入工作流',
      filters: [
        { name: 'ComfyUI 工作流', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const dir = getWorkflowDir({ workflowDir: agent?.workflowDir });
    if (!dir) throw new Error('工作流目录不存在');
    const imported = await importWorkflowFiles(result.filePaths, dir);
    if (agent && dir !== agent.workflowDir) await agent.setWorkflowDir(dir);
    getDirectService()?.setWorkflowDir(dir);
    return { dir, displayDir: getDisplayPath(dir), ...imported };
  });

  ipcMain.handle('import-workflows', async (_, { paths = [] } = {}) => {
    const agent = getAgent();
    const dir = getWorkflowDir({ workflowDir: agent?.workflowDir });
    if (!dir) throw new Error('工作流目录不存在');
    const result = await importWorkflowFiles(paths, dir);
    if (agent && dir !== agent.workflowDir) await agent.setWorkflowDir(dir);
    getDirectService()?.setWorkflowDir(dir);
    return { dir, displayDir: getDisplayPath(dir), ...result };
  });

  ipcMain.handle('select-media-files', async () => {
    const result = await dialog.showOpenDialog(ctx.getMainWindow?.(), {
      properties: ['openFile', 'multiSelections'],
      title: '选择参考素材',
      filters: [
        { name: '图片、音频和视频', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'mp4', 'webm', 'mov', 'mkv', 'avi'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (result.canceled) return [];
    const videoExtensions = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi']);
    const audioExtensions = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']);
    const authorizedMediaPaths = getAuthorizedMediaPaths();
    for (const filePath of result.filePaths) authorizedMediaPaths.add(filePath);
    return result.filePaths.map(filePath => ({
      path: filePath,
      name: basename(filePath),
      kind: videoExtensions.has(extname(filePath).toLowerCase()) ? 'video' : audioExtensions.has(extname(filePath).toLowerCase()) ? 'audio' : 'image',
    }));
  });

  ipcMain.handle('clipboard:save-paste', async (_, { buffer, name } = {}) => {
    if (!buffer || !buffer.length) throw new Error('剪贴板没有图片数据');
    const dir = app.getPath('temp');
    const fileName = `comfy-agent-paste-${Date.now()}-${Math.round(Math.random() * 0xffffff).toString(16)}.png`;
    const target = join(dir, fileName);
    await writeFile(target, Buffer.from(buffer));
    getAuthorizedMediaPaths().add(target);
    return { path: target, name: name || fileName, kind: 'image' };
  });

  ipcMain.handle('clipboard:write-image', async (_, dataUrl) => {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) throw new Error('无效的图片数据');
    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) throw new Error('剪贴板图片数据无效');
    clipboard.writeImage(image);
    return { ok: true };
  });
}
