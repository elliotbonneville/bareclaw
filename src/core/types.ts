/** NDJSON message written to claude's stdin */
export interface ClaudeInput {
  type: 'user';
  message: { role: 'user'; content: string };
}

/** Any NDJSON event from claude's stdout */
export interface ClaudeEvent {
  type: string;
  subtype?: string;
  message?: {
    role: string;
    content: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
      [key: string]: unknown;
    }>;
  };
  result?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  session_id?: string;
  is_error?: boolean;
  [key: string]: unknown;
}

export interface SendMessageRequest {
  text: string;
  channel?: string;
}

export interface SendMessageResponse {
  text: string;
  duration_ms: number;
}
