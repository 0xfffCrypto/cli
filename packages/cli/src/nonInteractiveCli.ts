/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Config,
  ToolCallRequestInfo,
  executeToolCall,
  ToolRegistry,
  shutdownTelemetry,
  isTelemetrySdkInitialized,
  ToolResultDisplay,
} from 'mine-ai-core';
import {
  Content,
  Part,
  FunctionCall,
  GenerateContentResponse,
} from '@google/genai';

import { parseAndFormatApiError } from './ui/utils/errorParsing.js';

function getResponseText(response: GenerateContentResponse): string | null {
  if (response.candidates && response.candidates.length > 0) {
    const candidate = response.candidates[0];
    if (
      candidate.content &&
      candidate.content.parts &&
      candidate.content.parts.length > 0
    ) {
      // We are running in headless mode so we don't need to return thoughts to STDOUT.
      const thoughtPart = candidate.content.parts[0];
      if (thoughtPart?.thought) {
        return null;
      }
      return candidate.content.parts
        .filter((part) => part.text)
        .map((part) => part.text)
        .join('');
    }
  }
  return null;
}

// Helper function to format tool call arguments for display
function formatToolArgs(args: Record<string, unknown>): string {
  if (!args || Object.keys(args).length === 0) {
    return '(no arguments)';
  }

  const formattedArgs = Object.entries(args)
    .map(([key, value]) => {
      if (typeof value === 'string') {
        return `${key}: "${value}"`;
      } else if (typeof value === 'object' && value !== null) {
        return `${key}: ${JSON.stringify(value)}`;
      } else {
        return `${key}: ${value}`;
      }
    })
    .join(', ');

  return `(${formattedArgs})`;
}
// Helper function to display tool call information
function displayToolCallInfo(
  toolName: string,
  args: Record<string, unknown>,
  status: 'start' | 'success' | 'error',
  resultDisplay?: ToolResultDisplay,
  errorMessage?: string,
): void {
  const timestamp = new Date().toLocaleTimeString();
  const argsStr = formatToolArgs(args);

  switch (status) {
    case 'start':
      process.stdout.write(
        `\n[${timestamp}] 🔧 Executing tool: ${toolName} ${argsStr}\n`,
      );
      break;
    case 'success':
      if (resultDisplay) {
        if (typeof resultDisplay === 'string' && resultDisplay.trim()) {
          process.stdout.write(
            `[${timestamp}] ✅ Tool ${toolName} completed successfully\n`,
          );
          process.stdout.write(`📋 Result:\n${resultDisplay}\n`);
        } else if (
          typeof resultDisplay === 'object' &&
          'fileDiff' in resultDisplay
        ) {
          process.stdout.write(
            `[${timestamp}] ✅ Tool ${toolName} completed successfully\n`,
          );
          process.stdout.write(`📋 File: ${resultDisplay.fileName}\n`);
          process.stdout.write(`📋 Diff:\n${resultDisplay.fileDiff}\n`);
        } else {
          process.stdout.write(
            `[${timestamp}] ✅ Tool ${toolName} completed successfully (no output)\n`,
          );
        }
      } else {
        process.stdout.write(
          `[${timestamp}] ✅ Tool ${toolName} completed successfully (no output)\n`,
        );
      }
      break;
    case 'error':
      process.stdout.write(
        `[${timestamp}] ❌ Tool ${toolName} failed: ${errorMessage}\n`,
      );
      break;
    default:
      process.stdout.write(
        `[${timestamp}] ⚠️ Tool ${toolName} reported unknown status: ${status}\n`,
      );
      break;
  }
}

export async function runNonInteractive(
  config: Config,
  input: string,
  prompt_id: string,
): Promise<void> {
  await config.initialize();
  // Handle EPIPE errors when the output is piped to a command that closes early.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      // Exit gracefully if the pipe is closed.
      process.exit(0);
    }
  });

  const geminiClient = config.getGeminiClient();
  const toolRegistry: ToolRegistry = await config.getToolRegistry();

  const chat = await geminiClient.getChat();
  const abortController = new AbortController();
  let currentMessages: Content[] = [{ role: 'user', parts: [{ text: input }] }];
  let turnCount = 0;
  try {
    while (true) {
      turnCount++;
      if (
        config.getMaxSessionTurns() > 0 &&
        turnCount > config.getMaxSessionTurns()
      ) {
        console.error(
          '\n Reached max session turns for this session. Increase the number of turns by specifying maxSessionTurns in settings.json.',
        );
        return;
      }
      const functionCalls: FunctionCall[] = [];

      const responseStream = await chat.sendMessageStream(
        {
          message: currentMessages[0]?.parts || [], // Ensure parts are always provided
          config: {
            abortSignal: abortController.signal,
            tools: [
              { functionDeclarations: toolRegistry.getFunctionDeclarations() },
            ],
          },
        },
        prompt_id,
      );

      for await (const resp of responseStream) {
        if (abortController.signal.aborted) {
          console.error('Operation cancelled.');
          return;
        }
        const textPart = getResponseText(resp);
        if (textPart) {
          process.stdout.write(textPart);
        }
        if (resp.functionCalls) {
          functionCalls.push(...resp.functionCalls);
        }
      }

      if (functionCalls.length > 0) {
        const toolResponseParts: Part[] = [];

        for (const fc of functionCalls) {
          const callId = fc.id ?? `${fc.name}-${Date.now()}`;
          const requestInfo: ToolCallRequestInfo = {
            callId,
            name: fc.name as string,
            args: (fc.args ?? {}) as Record<string, unknown>,
            isClientInitiated: false,
            prompt_id,
          };

          //Display tool call start information
          displayToolCallInfo(fc.name as string, fc.args ?? {}, 'start');

          const toolResponse = await executeToolCall(
            config,
            requestInfo,
            toolRegistry,
            abortController.signal,
          );

          if (toolResponse.error) {
            // Display tool call error information
            const errorMessage =
              typeof toolResponse.resultDisplay === 'string'
                ? toolResponse.resultDisplay
                : toolResponse.error?.message;

            displayToolCallInfo(
              fc.name as string,
              fc.args ?? {},
              'error',
              undefined,
              errorMessage,
            );

            const isToolNotFound = toolResponse.error.message.includes(
              'not found in registry',
            );
            console.error(
              `Error executing tool ${fc.name}: ${toolResponse.resultDisplay || toolResponse.error.message}`,
            );
            if (!isToolNotFound) {
              process.exit(1);
            }
          } else {
            // Display tool call success information
            displayToolCallInfo(
              fc.name as string,
              fc.args ?? {},
              'success',
              toolResponse.resultDisplay,
            );
          }

          if (toolResponse.responseParts) {
            const parts = Array.isArray(toolResponse.responseParts)
              ? toolResponse.responseParts
              : [toolResponse.responseParts];
            for (const part of parts) {
              if (typeof part === 'string') {
                toolResponseParts.push({ text: part });
              } else if (part) {
                toolResponseParts.push(part);
              }
            }
          }
        }
        currentMessages = [{ role: 'user', parts: toolResponseParts }];
      } else {
        process.stdout.write('\n'); // Ensure a final newline
        return;
      }
    }
  } catch (error) {
    console.error(
      parseAndFormatApiError(
        error,
        config.getContentGeneratorConfig()?.authType,
      ),
    );
    process.exit(1);
  } finally {
    if (isTelemetrySdkInitialized()) {
      await shutdownTelemetry();
    }
  }
}
