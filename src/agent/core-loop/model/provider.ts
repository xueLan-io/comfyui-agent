import type { ModelConfig } from '../config/env.ts';
import type { ChatModel } from '../core/types.ts';
import { MockChatModel } from './mock.ts';
import { OpenAiCompatibleChatModel } from './openai-compatible.ts';

export interface CreateModelOptions {
  config: ModelConfig;
  /** Overrides the scripted plan used by the mock provider, for tests. */
  mockModel?: ChatModel;
}

/**
 * The one place a provider is chosen.
 *
 * Everything above this line speaks `ChatModel`; provider SDK shapes never leak
 * out of `openai-compatible.ts`. That is what makes swapping providers a
 * configuration change rather than a refactor (docs/adr/0001).
 */
export function createChatModel(options: CreateModelOptions): ChatModel {
  if (options.mockModel) return options.mockModel;

  switch (options.config.provider) {
    case 'mock':
      return new MockChatModel();
    case 'openai':
      return new OpenAiCompatibleChatModel(options.config);
    default: {
      const exhaustive: never = options.config.provider;
      throw new Error(`Unsupported MODEL_PROVIDER: ${String(exhaustive)}`);
    }
  }
}
