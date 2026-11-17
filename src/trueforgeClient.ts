import { TrueForge } from "@truefoundry/trueforge-sdk";

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

/**
 * Thin wrapper around the TrueForge TypeScript SDK.
 * The extension never calls a model provider directly: it creates sessions
 * and sends turns through the local TrueForge server, and renders the
 * streamed events in the editor.
 */
export class ForgeClient {
  private client: TrueForge;
  private sessionId?: string;
  private currentTurnId?: string;

  constructor(private readonly baseUrl: string, private readonly spec: AgentSpecOptions) {
    this.client = new TrueForge({ baseUrl, timeoutInSeconds: 600 });
  }

  /** Open a session with an inline agent spec (no saved agent needed). */
  async ensureSession(): Promise<string> {
    if (this.sessionId) {
      return this.sessionId;
    }
    const { data: session } = await this.client.sessions.create({
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
    const stream = await this.client.sessions.createTurnStream(sessionId, {
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
    await this.client.sessions.createTurnEvents(this.sessionId, this.currentTurnId, {
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
    if (!this.sessionId) {
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
