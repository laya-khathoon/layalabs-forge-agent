/**
 * Thin wrapper around the TrueForge TypeScript SDK.
 * The extension never calls a model provider directly: it creates sessions
 * and sends turns through the local TrueForge server, and renders the
 * streamed events in the editor.
 *
 * The SDK is ESM-first: its CommonJS entry is broken in 0.185.x
 * (`require("@truefoundry/trueforge-sdk")` fails with MODULE_NOT_FOUND).
 * This extension compiles to CommonJS, so the SDK is loaded with a real
 * dynamic import() the first time it is needed instead of a top-level
 * require. (A plain `import()` would be rewritten to require() by the
 * commonjs module target, hence the Function indirection.)
 */

/** A single event from the TrueForge turn stream (kept loose on purpose; see turn events reference). */
export interface StreamedEvent {
  type: string;
  id?: string;
  threadId?: string | null;
  turnId?: string;
  content?: string;
  state?: { status?: string; output?: unknown };
  toolCalls?: { id: string; sourceEventId: string }[];
  [key: string]: unknown;
}

export interface AgentSpecOptions {
  model: string;
  instructions: string;
  mcpServerName: string;
}

/** The slice of the SDK client this wrapper uses. */
interface TrueForgeClientLike {
  sessions: {
    create(options: unknown): Promise<{ data: { id: string } }>;
    createTurnStream(
      sessionId: string,
      options: unknown,
    ): Promise<{ withMetadata(): AsyncIterable<{ data: unknown }> }>;
    createTurnEvents(sessionId: string, turnId: string, options: unknown): Promise<unknown>;
    cancel(sessionId: string): Promise<unknown>;
  };
}

type TrueForgeCtor = new (options: { baseUrl: string; timeoutInSeconds: number }) => TrueForgeClientLike;

let sdkPromise: Promise<TrueForgeCtor> | undefined;

function loadSdk(): Promise<TrueForgeCtor> {
  if (!sdkPromise) {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<{ TrueForge: TrueForgeCtor }>;
    sdkPromise = dynamicImport("@truefoundry/trueforge-sdk").then((m) => m.TrueForge);
  }
  return sdkPromise;
}

export class ForgeClient {
  private client?: TrueForgeClientLike;
  private sessionId?: string;
  private currentTurnId?: string;

  constructor(private readonly baseUrl: string, private readonly spec: AgentSpecOptions) {}

  private async ensureClient(): Promise<TrueForgeClientLike> {
    if (!this.client) {
      const TrueForge = await loadSdk();
      this.client = new TrueForge({ baseUrl: this.baseUrl, timeoutInSeconds: 600 });
    }
    return this.client;
  }

  /** Open a session with an inline agent spec (no saved agent needed). */
  async ensureSession(): Promise<string> {
    if (this.sessionId) {
      return this.sessionId;
    }
    const client = await this.ensureClient();
    const { data: session } = await client.sessions.create({
      agent: {
        spec: {
          model: { name: this.spec.model },
          instructions: this.spec.instructions,
          mcpServers: [
            {
              name: this.spec.mcpServerName,
              enableTools: ["@all"],
              // propose_write and run_command pause for human approval;
              // the approval answer goes back on the same turn.
              requireApprovalForTools: ["propose_write", "run_command"],
            },
          ],
        },
      },
    });
    this.sessionId = session.id;
    return this.sessionId;
  }

  /** Stream one turn. Yields every event, including model.message.delta chunks. */
  async *streamTurn(content: string): AsyncGenerator<StreamedEvent> {
    const sessionId = await this.ensureSession();
    const client = await this.ensureClient();
    const stream = await client.sessions.createTurnStream(sessionId, {
      input: [{ type: "user.message", content }],
    });
    for await (const { data: event } of stream.withMetadata()) {
      const ev = event as unknown as StreamedEvent;
      if (ev.type === "turn.created" && ev.id) {
        this.currentTurnId = (ev.turnId ?? ev.id) as string;
      }
      yield ev;
    }
  }

  /** Answer a tool.approval_required pause on the current turn. */
  async approve(threadId: string, toolCallId: string, allow: boolean, reason?: string): Promise<void> {
    if (!this.sessionId || !this.currentTurnId) {
      return;
    }
    const client = await this.ensureClient();
    await client.sessions.createTurnEvents(this.sessionId, this.currentTurnId, {
      events: [
        {
          type: "user.tool_approval",
          threadId,
          toolCallId,
          approval: allow ? { status: "allow" } : { status: "deny", reason },
        },
      ],
    });
  }

  /** Cancel the running turn. A cancelled run leaves the workspace untouched. */
  async cancel(): Promise<void> {
    if (!this.sessionId || !this.client) {
      return;
    }
    try {
      await this.client.sessions.cancel(this.sessionId);
    } catch {
      // Turn may already be finished; cancellation is best-effort.
    }
  }

  /** Forget the current session so the next turn starts a fresh one. */
  endSession(): void {
    this.sessionId = undefined;
    this.currentTurnId = undefined;
  }
}
