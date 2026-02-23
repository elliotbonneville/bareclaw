import { homedir } from 'os';

export interface Config {
  port: number;
  cwd: string;
  maxTurns: number;
  allowedTools: string;
  timeoutMs: number;
  httpToken: string | undefined;
  telegramToken: string | undefined;
  allowedUsers: number[];
}

export function loadConfig(): Config {
  const allowedUsersRaw = process.env.BARECLAW_ALLOWED_USERS?.trim();
  return {
    port: parseInt(process.env.BARECLAW_PORT || '3000', 10),
    cwd: (process.env.BARECLAW_CWD || homedir()).replace(/^~/, homedir()),
    maxTurns: parseInt(process.env.BARECLAW_MAX_TURNS || '25', 10),
    allowedTools: process.env.BARECLAW_ALLOWED_TOOLS || 'Read,Glob,Grep,Bash,Write,Edit,Skill,Task',
    timeoutMs: parseInt(process.env.BARECLAW_TIMEOUT_MS || '120000', 10),
    httpToken: process.env.BARECLAW_HTTP_TOKEN || undefined,
    telegramToken: process.env.BARECLAW_TELEGRAM_TOKEN || undefined,
    allowedUsers: allowedUsersRaw
      ? allowedUsersRaw.split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite)
      : [],
  };
}
