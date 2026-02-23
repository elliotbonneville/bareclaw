import { spawn, type ChildProcess } from 'child_process';
import { createInterface, type Interface } from 'readline';
import type { Config } from '../config.js';
import type { ClaudeEvent, ClaudeInput, SendMessageResponse } from './types.js';

export type EventCallback = (event: ClaudeEvent) => void;

interface QueuedMessage {
  text: string;
  resolve: (r: SendMessageResponse) => void;
  reject: (e: Error) => void;
  onEvent?: EventCallback;
}

interface ManagedProcess {
  proc: ChildProcess;
  rl: Interface;
  busy: boolean;
  queue: QueuedMessage[];
  eventHandler: ((event: ClaudeEvent) => void) | null;
}

export class ProcessManager {
  private channels = new Map<string, ManagedProcess>();
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async send(channel: string, text: string, onEvent?: EventCallback): Promise<SendMessageResponse> {
    let managed = this.channels.get(channel);

    // Spawn if needed
    if (!managed) {
      managed = this.spawnProcess(channel);
      this.channels.set(channel, managed);
    }

    // Queue if busy
    if (managed.busy) {
      return new Promise((resolve, reject) => {
        managed!.queue.push({ text, resolve, reject, onEvent });
      });
    }

    return this.dispatch(managed, text, onEvent);
  }

  shutdown(): void {
    for (const [channel, managed] of this.channels) {
      managed.proc.kill();
      managed.rl.close();
      console.log(`[process-manager] killed process for channel: ${channel}`);
    }
    this.channels.clear();
  }

  private spawnProcess(channel: string): ManagedProcess {
    console.log(`[process-manager] spawning claude for channel: ${channel}`);

    const { ANTHROPIC_API_KEY, CLAUDE_API_KEY, ...parentEnv } = process.env;
    const env = {
      ...parentEnv,
      CLAUDECODE: '',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };

    const proc = spawn('claude', [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--max-turns', String(this.config.maxTurns),
      '--allowedTools', this.config.allowedTools,
    ], {
      env,
      cwd: this.config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });

    const managed: ManagedProcess = {
      proc,
      rl,
      busy: false,
      queue: [],
      eventHandler: null,
    };

    // Route stdout lines to the current event handler
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as ClaudeEvent;
        console.log(`[process-manager] [${channel}] event: ${event.type}${event.subtype ? '/' + event.subtype : ''}`);
        if (managed.eventHandler) managed.eventHandler(event);
      } catch {
        console.log(`[process-manager] [${channel}] non-JSON: ${line.substring(0, 100)}`);
      }
    });

    // Collect stderr for debugging
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text && !text.includes('zoxide')) {
        console.error(`[process-manager] [${channel}] stderr: ${text.substring(0, 200)}`);
      }
    });

    // Auto-restart: clear entry so next send() spawns fresh
    proc.on('exit', (code) => {
      console.log(`[process-manager] process for channel ${channel} exited (code ${code})`);
      this.channels.delete(channel);
      // Reject any queued messages
      for (const queued of managed.queue) {
        queued.reject(new Error(`Process exited unexpectedly (code ${code})`));
      }
      managed.queue = [];
    });

    return managed;
  }

  private dispatch(managed: ManagedProcess, text: string, onEvent?: EventCallback): Promise<SendMessageResponse> {
    managed.busy = true;
    const start = Date.now();

    return new Promise<SendMessageResponse>((resolve, reject) => {
      // Timeout guard
      const timer = setTimeout(() => {
        managed.busy = false;
        managed.eventHandler = null;
        managed.proc.kill();
        reject(new Error(`Timed out after ${this.config.timeoutMs}ms`));
      }, this.config.timeoutMs);

      // Listen for events, forward to callback, resolve on result
      managed.eventHandler = (event) => {
        try {
          if (onEvent) onEvent(event);
        } catch (err) {
          console.error(`[process-manager] onEvent callback error: ${err}`);
        }

        if (event.type === 'result') {
          clearTimeout(timer);
          managed.eventHandler = null;
          managed.busy = false;

          const response: SendMessageResponse = {
            text: event.result || '',
            duration_ms: Date.now() - start,
          };

          resolve(response);
          this.drainQueue(managed);
        }
      };

      // Write message to stdin
      const msg: ClaudeInput = {
        type: 'user',
        message: { role: 'user', content: text },
      };
      managed.proc.stdin!.write(JSON.stringify(msg) + '\n');
    });
  }

  private drainQueue(managed: ManagedProcess): void {
    if (managed.queue.length === 0) return;
    const next = managed.queue.shift()!;
    this.dispatch(managed, next.text, next.onEvent).then(next.resolve, next.reject);
  }
}
