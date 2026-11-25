export declare const PROTOCOL_VERSION: 1;

export type ErrorCode =
  | "provider_not_found"
  | "provider_unavailable"
  | "authentication_required"
  | "capability_unavailable"
  | "skill_not_found"
  | "skill_invalid"
  | "skill_blocked"
  | "skill_unavailable"
  | "skill_digest_mismatch"
  | "permission_denied"
  | "policy_unenforceable"
  | "approval_timeout"
  | "execution_timeout"
  | "execution_failed"
  | "cancelled"
  | "session_not_found"
  | "provider_protocol_error"
  | "invalid_input"
  | "internal_error";

export declare class RbridgeError extends Error {
  code: ErrorCode;
  details: Record<string, string>;
}

export interface ContentBlock {
  type: "text" | "image" | "resource_link";
  text?: string;
  uri?: string;
  mime_type?: string;
  data?: string;
}

export type Prompt = string | ContentBlock[];

export interface Task {
  workspace: string;
  prompt?: Prompt;
  skills?: string[];
  provider?: string;
  requirements?: string[];
  profile?: "observe" | "standard" | "controlled" | "custom";
  /** Run the runtime in an OS sandbox (Linux): writes limited to the workspace, and with "full" no network. */
  sandbox?: "off" | "files" | "full";
  mcp_servers?: Array<Record<string, unknown>>;
  output_schema?: unknown;
  /** Nanoseconds. */
  timeout?: number;
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
}

export interface Result {
  session_id: string;
  stop_reason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
  output: string;
  structured?: unknown;
  usage?: Usage;
  provider: string;
  skills?: Array<{ skill_id: string; digest: string; mode: string }>;
}

export interface Event {
  seq: number;
  time: string;
  session_id: string;
  turn_id?: string;
  type: string;
  data?: any;
  provider?: string;
}

export interface ApprovalRequest {
  id: string;
  session_id: string;
  tool?: string;
  title: string;
  kind?: string;
  input?: unknown;
  options: Array<{ id: string; kind: string; name?: string }>;
}

/** remember allows the same tool and kind for the rest of the session. */
export type ApprovalAnswer = boolean | { allow: boolean; optionId?: string; remember?: boolean };

export interface InputRequest {
  id: string;
  session_id: string;
  message: string;
  mode: "form" | "url";
  /** JSON schema of the form, for mode "form". */
  schema?: Record<string, unknown>;
  /** Page the user should open, for mode "url". rbridge never opens it. */
  url?: string;
}

export interface InputAnswer {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

export interface SessionOptions {
  onEvent?: (event: Event) => void;
  approver?: (request: ApprovalRequest) => ApprovalAnswer | Promise<ApprovalAnswer>;
  /** Answers questions the runtime asks. Without it they are declined. */
  onInput?: (request: InputRequest) => InputAnswer | Promise<InputAnswer>;
  model?: string;
  /** Runtime session mode to switch to once the session opens. */
  mode?: string;
}

export interface Mode {
  id: string;
  name: string;
  description?: string;
}

export interface ConfigOption {
  id: string;
  name: string;
  description?: string;
  type: "select" | "boolean";
  current: string;
  options?: { value: string; name?: string }[];
}

export interface SessionRecord {
  id: string;
  provider_id: string;
  native_id?: string;
  workspace: string;
  profile?: string;
  state: string;
  turns: number;
  last_stop?: string;
  last_error?: string;
  created_at: string;
  updated_at: string;
}

export declare class Session {
  readonly id: string;
  readonly record: SessionRecord;
  prompt(prompt: Prompt): Promise<Result>;
  cancel(): Promise<unknown>;
  close(): Promise<void>;
  modes(): Promise<{ current: string; modes: Mode[] }>;
  setMode(mode: string): Promise<{ current: string; modes: Mode[] }>;
  options(): Promise<ConfigOption[]>;
  setOption(optionId: string, value: string | boolean): Promise<ConfigOption[]>;
}

export declare class Client {
  providers(options?: { refresh?: boolean }): Promise<any[]>;
  skills(): Promise<any[]>;
  /** Adds a skill folder on this machine to rbridge's library; it starts unreviewed. */
  addSkill(dir: string, options?: { link?: boolean }): Promise<{ record: { id: string; digest: string; trust: string }; warnings?: string[]; unchanged?: boolean }>;
  addCatalogSkill(ref: string): Promise<{ record: { id: string; digest: string; trust: string } }>;
  setSkillTrust(id: string, trust: "unreviewed" | "reviewed" | "trusted" | "restricted" | "blocked"): Promise<{ id: string; trust: string }>;
  searchSkills(query?: string): Promise<{ skills: any[]; problems: string[] }>;
  sessions(): Promise<SessionRecord[]>;
  status(): Promise<{ version: string; pid: number; started_at: string; sessions_open: number }>;
  open(task: Task, options?: SessionOptions): Promise<Session>;
  resume(id: string, options?: SessionOptions): Promise<Session>;
  run(task: Task & { prompt: Prompt }, options?: SessionOptions): Promise<Result>;
  close(): void;
}

export declare function text(s: string): ContentBlock[];
export declare function socketPath(env?: Record<string, string | undefined>): string;
export declare function runtimeDir(env?: Record<string, string | undefined>): string;
export declare function connect(options?: { socket?: string; client?: string; env?: Record<string, string | undefined> }): Promise<Client>;
export declare function connectHTTP(options?: { url?: string; token?: string; client?: string; env?: Record<string, string | undefined> }): Promise<Client>;
