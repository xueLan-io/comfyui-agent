export function formatAgentError(error) {
  const raw = String(error?.message || error || '').trim();
  const message = raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim();

  if (/INVALID_API_KEY|\b401\b|API Key[^\n]*(?:无效|invalid)/i.test(message)) {
    return 'API Key 无效，请打开“模型设置”更新后重试。';
  }
  if (/MODEL_NOT_FOUND|\b404\b|model[^\n]*not found/i.test(message)) {
    return '接口或模型不存在，请检查“模型设置”中的地址和模型名称。';
  }
  if (/RATE_LIMIT|\b429\b|too many requests/i.test(message)) {
    return '请求过于频繁或额度不足，请稍后重试并检查账户额度。';
  }
  if (/Workflow not found|workflow .* does not exist/i.test(message)) return '工作流不存在';
  if (/reference media was not connected|no_load_image_node|reference.*loader/i.test(message)) return '参考图没有接入任何加载节点';
  if (/negative prompt input|negative prompt.*unsupported/i.test(message)) return '当前工作流没有可用负面提示词输入';
  if (/ComfyUI generation timeout|execution timeout/i.test(message)) return 'ComfyUI 执行超时';
  if (/selected output node|no images in output|without a valid image/i.test(message)) return '输出节点没有产生图片';
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|network error/i.test(message)) {
    return '无法连接模型接口，请检查接口地址和网络连接。';
  }

  const apiMessage = message.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/i)?.[1];
  if (apiMessage) {
    try {
      return JSON.parse(`"${apiMessage}"`);
    } catch {}
  }

  return message || '请求失败，请检查模型设置后重试。';
}
