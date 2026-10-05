/**
 * Markdown from agents and the client, rendered as text: raw HTML is dropped
 * and links open in a new tab without an opener.
 */
import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
};

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className ? `md ${className}` : 'md'}>
      <ReactMarkdown components={components} remarkPlugins={[remarkGfm]} skipHtml>{text}</ReactMarkdown>
    </div>
  );
});
