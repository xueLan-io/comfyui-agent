/**
 * Clean JSON content by removing markdown code fences
 * @param {string} content - Raw content from LLM
 * @returns {string} Cleaned content ready for JSON.parse
 */
export function cleanJsonContent(content) {
  if (!content) return '';
  return String(content)
    .replace(/^```(?:json|JSON)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

/**
 * Parse JSON with automatic code fence cleaning
 * @param {string} content - Raw content from LLM
 * @param {string} source - Source name for error messages
 * @returns {any} Parsed JSON
 * @throws {Error} If JSON is invalid
 */
export function parseCleanJson(content, source = 'Model') {
  if (!content) {
    const error = new Error(`${source} 未返回内容，请检查语言模型后重试。`);
    error.code = 'MODEL_INVALID_JSON';
    throw error;
  }
  const cleaned = cleanJsonContent(content);
  try {
    return JSON.parse(cleaned);
  } catch {
    const error = new Error(`${source} 返回的 JSON 不完整或无效，请检查语言模型后重试。`);
    error.code = 'MODEL_INVALID_JSON';
    throw error;
  }
}