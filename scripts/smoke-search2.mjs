import { createWebTool } from '../src/agent/tools/web/index.mjs';

const tool = createWebTool();
for (const query of ['联网帮我查一下 Flux 和 SD3.5 的对比评测', '帮我查一下现在有什么好用的视频生成模型']) {
  const started = Date.now();
  const result = await tool.execute({
    action: 'search',
    query,
    maxResults: 5,
    timeoutMs: 12000,
    providers: ['bing', 'duckduckgo', 'baidu'],
  });
  console.log(`\n=== 查询: ${query}`);
  console.log(`耗时 ${Date.now() - started}ms  provider: ${result.provider || '(无)'}  error: ${result.error || '(无)'}`);
  for (const item of (result.results || []).slice(0, 5)) {
    console.log(' -', item.title.slice(0, 60));
    console.log('   ', item.url.slice(0, 80));
  }
}
