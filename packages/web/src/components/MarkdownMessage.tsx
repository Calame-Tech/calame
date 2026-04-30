import type { ReactNode, ComponentPropsWithoutRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  content: string;
}

export default function MarkdownMessage({ content }: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // Tables
        table: ({ children }: { children?: ReactNode }) => (
          <div className="overflow-x-auto my-2">
            <table className="min-w-full text-xs border-collapse">{children}</table>
          </div>
        ),
        thead: ({ children }: { children?: ReactNode }) => (
          <thead className="border-b border-gray-600">{children}</thead>
        ),
        tbody: ({ children }: { children?: ReactNode }) => <tbody>{children}</tbody>,
        tr: ({ children }: { children?: ReactNode }) => (
          <tr className="border-b border-gray-700/50 even:bg-gray-800/30">{children}</tr>
        ),
        th: ({ children }: { children?: ReactNode }) => (
          <th className="px-3 py-1.5 text-left font-semibold text-gray-200 whitespace-nowrap">
            {children}
          </th>
        ),
        td: ({ children }: { children?: ReactNode }) => (
          <td className="px-3 py-1.5 text-gray-300">{children}</td>
        ),
        // Code blocks
        pre: ({ children }: { children?: ReactNode }) => (
          <pre className="bg-gray-900 rounded-md p-3 my-2 overflow-x-auto text-xs font-mono text-gray-200">
            {children}
          </pre>
        ),
        code: ({ children, className, ...props }: ComponentPropsWithoutRef<'code'>) => {
          const isInline = !className?.startsWith('language-');
          return isInline ? (
            <code
              className="bg-gray-800 px-1 py-0.5 rounded text-xs font-mono text-gray-200"
              {...props}
            >
              {children}
            </code>
          ) : (
            <code className={`text-xs font-mono ${className ?? ''}`} {...props}>
              {children}
            </code>
          );
        },
        // Paragraphs & lists
        p: ({ children }: { children?: ReactNode }) => (
          <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>
        ),
        ul: ({ children }: { children?: ReactNode }) => (
          <ul className="list-disc list-inside space-y-1 mb-2 text-gray-300">{children}</ul>
        ),
        ol: ({ children }: { children?: ReactNode }) => (
          <ol className="list-decimal list-inside space-y-1 mb-2 text-gray-300">{children}</ol>
        ),
        li: ({ children }: { children?: ReactNode }) => (
          <li className="leading-relaxed">{children}</li>
        ),
        // Headings
        h1: ({ children }: { children?: ReactNode }) => (
          <h1 className="text-base font-bold text-gray-100 mb-2 mt-3">{children}</h1>
        ),
        h2: ({ children }: { children?: ReactNode }) => (
          <h2 className="text-sm font-semibold text-gray-100 mb-1.5 mt-2">{children}</h2>
        ),
        h3: ({ children }: { children?: ReactNode }) => (
          <h3 className="text-sm font-medium text-gray-200 mb-1 mt-2">{children}</h3>
        ),
        // Emphasis
        strong: ({ children }: { children?: ReactNode }) => (
          <strong className="font-semibold text-gray-100">{children}</strong>
        ),
        em: ({ children }: { children?: ReactNode }) => (
          <em className="italic text-gray-300">{children}</em>
        ),
        // Blockquote
        blockquote: ({ children }: { children?: ReactNode }) => (
          <blockquote className="border-l-2 border-gray-600 pl-3 my-2 text-gray-400 italic">
            {children}
          </blockquote>
        ),
        // HR
        hr: () => <hr className="border-gray-700 my-3" />,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
