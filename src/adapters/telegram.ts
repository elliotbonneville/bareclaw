import { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import type { Config } from '../config.js';
import type { ProcessManager } from '../core/process-manager.js';
import type { ClaudeEvent } from '../core/types.js';

const MAX_MESSAGE_LENGTH = 4096;

/** Split text into chunks that fit Telegram's message limit */
function splitText(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
    parts.push(text.substring(i, i + MAX_MESSAGE_LENGTH));
  }
  return parts;
}

/** Send a message with Markdown, falling back to plain text */
async function sendMessage(ctx: Context, text: string): Promise<void> {
  for (const chunk of splitText(text)) {
    await ctx.reply(chunk, { parse_mode: 'Markdown' }).catch(() => ctx.reply(chunk));
  }
}

/** Extract displayable content from a stream event */
function extractContent(event: ClaudeEvent): { text?: string; toolUse?: string } {
  if (event.type !== 'assistant' || !event.message?.content) return {};

  const texts: string[] = [];
  const tools: string[] = [];

  for (const block of event.message.content) {
    if (block.type === 'text' && block.text?.trim()) {
      texts.push(block.text);
    } else if (block.type === 'tool_use' && block.name) {
      const input = block.input as Record<string, unknown> | undefined;
      const target = input?.file_path || input?.path || input?.pattern || input?.command;
      tools.push(target ? `\`${block.name}: ${target}\`` : `\`${block.name}\``);
    }
  }

  return {
    text: texts.length > 0 ? texts.join('\n') : undefined,
    toolUse: tools.length > 0 ? tools.join('\n') : undefined,
  };
}

export function createTelegramAdapter(config: Config, processManager: ProcessManager): Telegraf {
  if (config.allowedUsers.length === 0) {
    throw new Error(
      'BARECLAW_ALLOWED_USERS is required when Telegram is enabled. ' +
      'BAREclaw has shell access — an open bot is an open door to your machine.'
    );
  }

  const bot = new Telegraf(config.telegramToken!, {
    handlerTimeout: config.timeoutMs + 10_000,
  });

  bot.catch((err) => {
    console.error(`[telegram] unhandled error: ${err instanceof Error ? err.message : err}`);
  });

  bot.on('text', async (ctx) => {
    const userId = ctx.from.id;

    if (!config.allowedUsers.includes(userId)) {
      console.log(`[telegram] blocked message from user ${userId}`);
      return;
    }

    const text = ctx.message.text;
    console.log(`[telegram] <- user ${userId}: ${text.substring(0, 80)}${text.length > 80 ? '...' : ''}`);

    // Show typing indicator
    await ctx.sendChatAction('typing');
    const typingInterval = setInterval(() => {
      ctx.sendChatAction('typing').catch(() => {});
    }, 4000);

    try {
      // Chain intermediate sends to preserve ordering
      let sendChain = Promise.resolve();
      let sentIntermediate = false;

      const response = await processManager.send('telegram', text, (event: ClaudeEvent) => {
        const { text: assistantText, toolUse } = extractContent(event);

        if (assistantText) {
          sentIntermediate = true;
          sendChain = sendChain.then(() => sendMessage(ctx, assistantText)).catch((err) => {
            console.error(`[telegram] failed to send intermediate text: ${err}`);
          });
        }

        if (toolUse) {
          sendChain = sendChain.then(() => ctx.reply(toolUse)).catch((err) => {
            console.error(`[telegram] failed to send tool notification: ${err}`);
          });
        }
      });

      // Wait for all intermediate messages to flush
      await sendChain;
      clearInterval(typingInterval);

      console.log(`[telegram] -> user ${userId}: ${response.duration_ms}ms`);

      // Only send final result if we didn't already stream content
      if (!sentIntermediate) {
        await sendMessage(ctx, response.text);
      }
    } catch (err) {
      clearInterval(typingInterval);
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[telegram] error: ${message}`);
      await ctx.reply(`Error: ${message}`).catch(() => {});
    }
  });

  return bot;
}
