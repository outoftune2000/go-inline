export type Mode = 'automatic' | 'manual';
export type ProviderId = 'llamacpp' | 'zen' | 'openrouter';
export interface CodeContext {
  prefix: string;
  suffix: string;
  declarations: string;
}
export interface CompletionRequest extends CodeContext {
  mode: Mode;
  maxTokens: number;
  signal: AbortSignal;
}
export interface ModelOptions {
  endpoint: string;
  model: string;
  apiKey?: string;
}
export interface ModelProvider {
  complete(request: CompletionRequest): Promise<string>;
  check(signal: AbortSignal): Promise<void>;
}
