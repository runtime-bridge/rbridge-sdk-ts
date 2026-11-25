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
  /** Defaults to the current folder; a relative path is made absolute. */
  workspace?: string;
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

export interface AddSkillsOptions {
  /** Add only the skills with these names or patterns, such as "metric-*". */
  only?: string[];
  /** Leave out the skills with these names or patterns. */
  exclude?: string[];
  /** Trust state set on every skill added. */
  trust?: "unreviewed" | "reviewed" | "trusted" | "restricted" | "blocked";
  /** Find and check the skills without installing any. */
  dryRun?: boolean;
  link?: boolean;
  /** Git only: the revision, and folders inside the repository (default: all of it). */
  rev?: string;
  subdirs?: string[];
}

export interface AddSkillsResult {
  items: Array<{
    id?: string;
    source: string;
    status: "added" | "updated" | "unchanged" | "would_add" | "skipped" | "failed";
    result?: { record: { id: string; digest: string; trust: string }; warnings?: string[]; unchanged?: boolean };
    reason?: string;
  }>;
  warnings?: string[];
  dry_run?: boolean;
}

/** The rbridge program from this machine's platform package, or null when none is installed. */
export declare function bundledBinary(): string | null;
/** RBRIDGE_BIN, else the bundled program, else rbridge on PATH. */
export declare function findBinary(env?: Record<string, string | undefined>): string | null;
/** The project's .rbridge folder that a bundled rbridge uses when RBRIDGE_HOME is unset, or null. */
export declare function projectHome(): string | null;
/** Starts the daemon for this environment's rbridge home, if none is running. */
export declare function startDaemon(env?: Record<string, string | undefined>, exitWhenIdle?: string | null): void;

export declare class Client {
  providers(options?: { refresh?: boolean }): Promise<any[]>;
  skills(): Promise<any[]>;
  /** Adds a skill folder on this machine to rbridge's library; it starts unreviewed. */
  addSkill(dir: string, options?: { link?: boolean }): Promise<{ record: { id: string; digest: string; trust: string }; warnings?: string[]; unchanged?: boolean }>;
  /** Adds every skill found in folders (or a Git repository), with filters; see AddSkillsOptions. */
  addSkills(source: string | string[], options?: AddSkillsOptions): Promise<AddSkillsResult>;
  addCatalogSkill(ref: string): Promise<{ record: { id: string; digest: string; trust: string } }>;
  setSkillTrust(id: string, trust: "unreviewed" | "reviewed" | "trusted" | "restricted" | "blocked"): Promise<{ id: string; trust: string }>;
  searchSkills(query?: string): Promise<{ skills: any[]; problems: string[] }>;
  sessions(): Promise<SessionRecord[]>;
  status(): Promise<{ version: string; pid: number; started_at: string; sessions_open: number }>;
  open(task: Task | string, options?: SessionOptions): Promise<Session>;
  resume(id: string, options?: SessionOptions): Promise<Session>;
  run(task: (Task & { prompt: Prompt }) | string, options?: SessionOptions): Promise<Result>;
  close(): void;
}

export declare function text(s: string): ContentBlock[];
export declare function socketPath(env?: Record<string, string | undefined>): string;
export declare function runtimeDir(env?: Record<string, string | undefined>): string;
/** A daemon that is not running is started first (the bundled rbridge, RBRIDGE_BIN or rbridge on PATH) unless start is false. */
export declare function connect(options?: { socket?: string; client?: string; env?: Record<string, string | undefined>; start?: boolean }): Promise<Client>;
export declare function connectHTTP(options?: { url?: string; token?: string; client?: string; env?: Record<string, string | undefined> }): Promise<Client>;

// ------------------------------------------------------------ everyday API

export type Approve = boolean | "allow" | "deny" | "read" | ((request: any) => boolean | Promise<boolean>);

export interface RunOptions {
  /** A runtime id from rb.runtimes(), such as "claude-code". Unset lets rbridge choose. */
  runtime?: string;
  model?: string;
  /** Defaults to the current folder. */
  workspace?: string;
  /** Skill ids, or folders of skills your program ships (added and trusted as reviewed). */
  skills?: string[];
  /** "observe" (read-only), "standard", "controlled" or "custom". */
  profile?: string;
  /** What to do when the runtime asks permission. Default false: deny. */
  approve?: Approve;
  sandbox?: "files" | "full";
  /** Seconds. */
  timeout?: number;
}

export interface RbridgeOptions extends RunOptions {
  maxConcurrency?: number;
  /** No new run starts once this many US dollars have been spent. */
  maxCostUsd?: number;
  /** The client name the daemon sees. */
  app?: string;
  env?: Record<string, string | undefined>;
  client?: Client;
}

export declare class Response {
  text: string;
  runtime: string;
  sessionId: string;
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  /** The answer parsed as JSON when a schema was given, else null. */
  data: any;
  raw: Result;
}

export declare class Stream implements AsyncIterable<string> {
  response: Response | null;
  events: Event[];
  [Symbol.asyncIterator](): AsyncIterator<string>;
  /** Waits for the whole answer and returns its text. */
  text(): Promise<string>;
}

export declare class Chat {
  readonly id: string | null;
  send(prompt: Prompt, options?: { stream?: false }): Promise<Response>;
  send(prompt: Prompt, options: { stream: true }): Promise<Stream>;
  close(): Promise<void>;
}

export declare class Rbridge {
  constructor(options?: RbridgeOptions);
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  /** The lower-level Client, connected on first use. */
  client(): Promise<Client>;
  run(prompt: Prompt, options?: RunOptions & { stream?: false; schema?: object; onEvent?: (e: Event) => void }): Promise<Response>;
  run(prompt: Prompt, options: RunOptions & { stream: true; schema?: object; onEvent?: (e: Event) => void }): Promise<Stream>;
  runMany(prompts: Array<Prompt | ({ prompt: Prompt } & RunOptions)>, options?: RunOptions & { returnExceptions?: boolean; maxConcurrency?: number; schema?: object }): Promise<Array<Response | Error>>;
  chat(options?: RunOptions): Chat;
  runtimes(): Promise<Array<{ id: string; name: string; available: boolean; version?: string }>>;
  addSkills(source: string | string[], options?: { trust?: string; only?: string[]; exclude?: string[] }): Promise<string[]>;
  close(): Promise<void>;
}
