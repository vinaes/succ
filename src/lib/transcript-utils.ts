/**
 * Shared transcript content helpers.
 *
 * Used by daemon/session and idle-context processors to keep parsing behavior
 * consistent across transcript consumers.
 */

export interface TranscriptBlock {
  type?: string;
  text?: string;
}

export type TranscriptContent = string | TranscriptBlock[] | null | undefined;

export interface TranscriptMessage {
  type?: string;
  message?: {
    content?: TranscriptContent;
  };
}

export function getTextContent(content: TranscriptContent): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is TranscriptBlock & { text: string } => {
        return block?.type === 'text' && typeof block.text === 'string';
      })
      .map((block) => block.text)
      .join(' ');
  }
  return '';
}

export function formatTranscriptLines(
  messages: TranscriptMessage[],
  opts: { assistantLimit?: number; userLimit?: number } = {}
): string[] {
  const assistantLimit = opts.assistantLimit ?? 1000;
  const userLimit = opts.userLimit ?? 500;
  const lines: string[] = [];

  for (const entry of messages) {
    if (entry.type === 'assistant' && entry.message?.content) {
      const text = getTextContent(entry.message.content);
      if (text) lines.push(`Assistant: ${text.substring(0, assistantLimit)}`);
      continue;
    }

    if ((entry.type === 'human' || entry.type === 'user') && entry.message?.content) {
      const text = getTextContent(entry.message.content);
      if (text) lines.push(`User: ${text.substring(0, userLimit)}`);
    }
  }

  return lines;
}
