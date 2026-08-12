import { useEffect, useId, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';

const markdownPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [rehypeKatex];
const safeUrl = /^https?:/i;

function getMermaidTheme() {
  const theme = document.documentElement.dataset.theme;
  const systemPrefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  return ['light', 'paper', 'mist', 'warm'].includes(theme) || (theme === 'system' && systemPrefersLight) ? 'default' : 'dark';
}

function MermaidDiagram({ source }) {
  const id = useId().replace(/:/g, '-');
  const [diagram, setDiagram] = useState('');
  const [error, setError] = useState('');
  const [theme, setTheme] = useState(getMermaidTheme);

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const refreshTheme = () => setTheme(getMermaidTheme());
    const observer = new MutationObserver(refreshTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    media.addEventListener('change', refreshTheme);
    return () => { observer.disconnect(); media.removeEventListener('change', refreshTheme); };
  }, []);

  useEffect(() => {
    let active = true;
    setDiagram('');
    setError('');

    import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme,
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim(),
        deterministicIds: true,
        deterministicIDSeed: id,
      });
      const { svg } = await mermaid.render(`mermaid-${id}`, source);
      if (active) setDiagram(svg);
    }).catch(() => {
      if (active) setError('无法渲染 Mermaid 图表');
    });

    return () => { active = false; };
  }, [id, source, theme]);

  if (error) return <pre className="markdown-diagram-error"><code>{error}{'\n\n'}{source}</code></pre>;
  if (!diagram) return <pre className="markdown-diagram-loading"><code>{source}</code></pre>;
  return <div className="markdown-diagram" dangerouslySetInnerHTML={{ __html: diagram }} />;
}

function openLink(event, href) {
  event.preventDefault();
  if (!safeUrl.test(href || '')) return;
  window.electronAPI?.openExternal?.(href).catch(() => window.open(href, '_blank', 'noopener,noreferrer'));
}

export default function MarkdownContent({ children }) {
  return (
    <ReactMarkdown
      remarkPlugins={markdownPlugins}
      rehypePlugins={rehypePlugins}
      components={{
        a: ({ children: label, href = '', ...props }) => <a {...props} href={href} onClick={event => openLink(event, href)}>{label}</a>,
        img: ({ alt = '', src = '' }) => safeUrl.test(src) ? <img src={src} alt={alt} loading="lazy" /> : <span>{alt}</span>,
        pre: ({ children: block }) => {
          const language = /language-([\w-]+)/.exec(block?.props?.className || '')?.[1]?.toLowerCase();
          return language === 'mermaid' ? block : <pre>{block}</pre>;
        },
        code: ({ children: code, className, ...props }) => {
          const language = /language-([\w-]+)/.exec(className || '')?.[1]?.toLowerCase();
          const source = String(code).replace(/\n$/, '');
          if (language === 'mermaid') return <MermaidDiagram source={source} />;
          return <code className={className} {...props}>{code}</code>;
        },
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
