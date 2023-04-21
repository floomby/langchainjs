import { v4 as uuidv4 } from "uuid";
import {
  AgentAction,
  AgentFinish,
  ChainValues,
  LLMResult,
} from "../schema/index.js";
import { BaseCallbackHandler, BaseCallbackHandlerMethods } from "./base.js";
import { ConsoleCallbackHandler } from "./handlers/console.js";
import { getTracingCallbackHandler } from "./handlers/initialize.js";

type BaseCallbackManagerMethods = {
  [K in keyof BaseCallbackHandlerMethods]?: (
    ...args: Parameters<Required<BaseCallbackHandlerMethods>[K]>
  ) => Promise<unknown>;
};

export interface CallbackManagerOptions {
  verbose?: boolean;
  tracing?: boolean;
}

export abstract class BaseCallbackManager {
  abstract addHandler(handler: BaseCallbackHandler): void;

  abstract removeHandler(handler: BaseCallbackHandler): void;

  abstract setHandlers(handlers: BaseCallbackHandler[]): void;

  setHandler(handler: BaseCallbackHandler): void {
    return this.setHandlers([handler]);
  }
}

class BaseRunManager {
  constructor(
    public readonly runId: string,
    protected readonly handlers: BaseCallbackHandler[],
    protected readonly inheritableHandlers: BaseCallbackHandler[],
    protected readonly _parentRunId?: string
  ) {}

  async handleText(text: string): Promise<void> {
    await Promise.all(
      this.handlers.map(async (handler) => {
        try {
          await handler.handleText?.(text, this.runId, this._parentRunId);
        } catch (err) {
          console.error(
            `Error in handler ${handler.constructor.name}, handleText: ${err}`
          );
        }
      })
    );
  }
}

export class CallbackManagerForLLMRun
  extends BaseRunManager
  implements BaseCallbackManagerMethods
{
  async handleLLMNewToken(token: string): Promise<void> {
    await Promise.all(
      this.handlers.map(async (handler) => {
        if (!handler.ignoreLLM) {
          try {
            await handler.handleLLMNewToken?.(
              token,
              this.runId,
              this._parentRunId
            );
          } catch (err) {
            console.error(
              `Error in handler ${handler.constructor.name}, handleLLMNewToken: ${err}`
            );
          }
        }
      })
    );
  }

  async handleLLMError(err: Error | unknown): Promise<void> {
    await Promise.all(
      this.handlers.map(async (handler) => {
        if (!handler.ignoreLLM) {
          try {
            await handler.handleLLMError?.(err, this.runId, this._parentRunId);
          } catch (err) {
            console.error(
              `Error in handler ${handler.constructor.name}, handleLLMError: ${err}`
            );
          }
        }
      })
    );
  }

  async handleLLMEnd(output: LLMResult): Promise<void> {
    await Promise.all(
      this.handlers.map(async (handler) => {
        if (!handler.ignoreLLM) {
          try {
            await handler.handleLLMEnd?.(output, this.runId, this._parentRunId);
          } catch (err) {
            console.error(
              `Error in handler ${handler.constructor.name}, handleLLMEnd: ${err}`
            );
          }
        }
      })
    );
  }
}

export class CallbackManagerForChainRun
  extends BaseRunManager
  implements BaseCallbackManagerMethods
{
  getChild(): CallbackManager {
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    const manager = new CallbackManager(this.runId);
    manager.setHandlers(this.inheritableHandlers);
    return manager;
  }

  async handleChainError(err: Error | unknown): Promise<void> {
    await Promise.all(
      this.handlers.map(async (handler) => {
        if (!handler.ignoreChain) {
          try {
            await handler.handleChainError?.(
              err,
              this.runId,
              this._parentRunId
            );
          } catch (err) {
            console.error(
              `Error in handler ${handler.constructor.name}, handleChainError: ${err}`
            );
          }
        }
      })
    );
  }

  async handleChainEnd(output: ChainValues): Promise<void> {
    await Promise.all(
      this.handlers.map(async (handler) => {
        if (!handler.ignoreChain) {
          try {
            await handler.handleChainEnd?.(
              output,
              this.runId,
              this._parentRunId
            );
          } catch (err) {
            console.error(
              `Error in handler ${handler.constructor.name}, handleChainEnd: ${err}`
            );
          }
        }
      })
    );
  }

  async handleAgentAction(action: AgentAction): Promise<void> {
    await Promise.all(
      this.handlers.map(async (handler) => {
        if (!handler.ignoreAgent) {
          try {
            await handler.handleAgentAction?.(
              action,
              this.runId,
              this._parentRunId
            );
          } catch (err) {
            console.error(
              `Error in handler ${handler.constructor.name}, handleAgentAction: ${err}`
            );
          }
        }
      })
    );
  }

  async handleAgentEnd(action: AgentFinish): Promise<void> {
    await Promise.all(
      this.handlers.map(async (handler) => {
        if (!handler.ignoreAgent) {
          try {
            await handler.handleAgentEnd?.(
              action,
              this.runId,
              this._parentRunId
            );
          } catch (err) {
            console.error(
              `Error in handler ${handler.constructor.name}, handleAgentEnd: ${err}`
            );
          }
        }
      })
    );
  }
}

export class CallbackManagerForToolRun
  extends BaseRunManager
  implements BaseCallbackManagerMethods
{
  getChild(): CallbackManager {
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    const manager = new CallbackManager(this.runId);
    manager.setHandlers(this.inheritableHandlers);
    return manager;
  }

  async handleToolError(err: Error | unknown): Promise<void> {
    await Promise.all(
      this.handlers.map(async (handler) => {
        if (!handler.ignoreAgent) {
          try {
            await handler.handleToolError?.(err, this.runId, this._parentRunId);
          } catch (err) {
            console.error(
              `Error in handler ${handler.constructor.name}, handleToolError: ${err}`
            );
          }
        }
      })
    );
  }

  async handleToolEnd(output: string): Promise<void> {
    await Promise.all(
      this.handlers.map(async (handler) => {
        if (!handler.ignoreAgent) {
          try {
            await handler.handleToolEnd?.(
              output,
              this.runId,
              this._parentRunId
            );
          } catch (err) {
            console.error(
              `Error in handler ${handler.constructor.name}, handleToolEnd: ${err}`
            );
          }
        }
      })
    );
  }
}

export class CallbackManager
  extends BaseCallbackManager
  implements BaseCallbackManagerMethods
{
  handlers: BaseCallbackHandler[];

  inheritableHandlers: BaseCallbackHandler[];

  name = "callback_manager";

  private readonly _parentRunId?: string;

  constructor(parentRunId?: string) {
    super();
    this.handlers = [];
    this.inheritableHandlers = [];
    this._parentRunId = parentRunId;
  }

  async handleLLMStart(
    llm: { name: string },
    prompts: string[],
    runId: string = uuidv4()
  ): Promise<CallbackManagerForLLMRun> {
    await Promise.all(
      this.handlers.map(async (handler) => {
        if (!handler.ignoreLLM) {
          try {
            await handler.handleLLMStart?.(
              llm,
              prompts,
              runId,
              this._parentRunId
            );
          } catch (err) {
            console.error(
              `Error in handler ${handler.constructor.name}, handleLLMStart: ${err}`
            );
          }
        }
      })
    );
    return new CallbackManagerForLLMRun(
      runId,
      this.handlers,
      this.inheritableHandlers,
      this._parentRunId
    );
  }

  async handleChainStart(
    chain: { name: string },
    inputs: ChainValues,
    runId = uuidv4()
  ): Promise<CallbackManagerForChainRun> {
    await Promise.all(
      this.handlers.map(async (handler) => {
        if (!handler.ignoreChain) {
          try {
            await handler.handleChainStart?.(
              chain,
              inputs,
              runId,
              this._parentRunId
            );
          } catch (err) {
            console.error(
              `Error in handler ${handler.constructor.name}, handleChainStart: ${err}`
            );
          }
        }
      })
    );
    return new CallbackManagerForChainRun(
      runId,
      this.handlers,
      this.inheritableHandlers,
      this._parentRunId
    );
  }

  async handleToolStart(
    tool: { name: string },
    input: string,
    runId = uuidv4()
  ): Promise<CallbackManagerForToolRun> {
    await Promise.all(
      this.handlers.map(async (handler) => {
        if (!handler.ignoreAgent) {
          try {
            await handler.handleToolStart?.(
              tool,
              input,
              runId,
              this._parentRunId
            );
          } catch (err) {
            console.error(
              `Error in handler ${handler.constructor.name}, handleToolStart: ${err}`
            );
          }
        }
      })
    );
    return new CallbackManagerForToolRun(
      runId,
      this.handlers,
      this.inheritableHandlers,
      this._parentRunId
    );
  }

  addHandler(handler: BaseCallbackHandler, inherit = true): void {
    this.handlers.push(handler);
    if (inherit) {
      this.inheritableHandlers.push(handler);
    }
  }

  removeHandler(handler: BaseCallbackHandler): void {
    this.handlers = this.handlers.filter((_handler) => _handler !== handler);
    this.inheritableHandlers = this.inheritableHandlers.filter(
      (_handler) => _handler !== handler
    );
  }

  setHandlers(handlers: BaseCallbackHandler[], inherit = true): void {
    this.handlers = [];
    this.inheritableHandlers = [];
    for (const handler of handlers) {
      this.addHandler(handler, inherit);
    }
  }

  copy(
    additionalHandlers: BaseCallbackHandler[] = [],
    inherit = true
  ): CallbackManager {
    const manager = new CallbackManager(this._parentRunId);
    manager.setHandlers([...this.handlers].map((handler) => handler.copy()));
    for (const handler of additionalHandlers) {
      manager.addHandler(handler.copy(), inherit);
    }
    return manager;
  }

  static fromHandlers(handlers: BaseCallbackHandlerMethods) {
    class Handler extends BaseCallbackHandler {
      name = uuidv4();

      constructor() {
        super();
        Object.assign(this, handlers);
      }
    }

    const manager = new this();
    manager.addHandler(new Handler());
    return manager;
  }

  static async configure(
    inheritableHandlers?: CallbackManager | BaseCallbackHandler[],
    localHandlers?: BaseCallbackHandler[],
    options?: CallbackManagerOptions
  ): Promise<CallbackManager | undefined> {
    let callbackManager: CallbackManager | undefined;
    if (inheritableHandlers || localHandlers) {
      if (Array.isArray(inheritableHandlers) || !inheritableHandlers) {
        callbackManager = new CallbackManager();
        callbackManager.setHandlers(inheritableHandlers ?? [], true);
      } else {
        callbackManager = inheritableHandlers;
      }
      callbackManager = callbackManager.copy(localHandlers, false);
    }
    // eslint-disable-next-line no-process-env
    if (options?.verbose || process.env.LANGCHAIN_TRACING !== undefined) {
      if (!callbackManager) {
        callbackManager = new CallbackManager();
      }
      const consoleHandler = new ConsoleCallbackHandler();
      if (
        options?.verbose &&
        !callbackManager.handlers.some(
          (handler) => handler.name === consoleHandler.name
        )
      ) {
        callbackManager.addHandler(consoleHandler, false);
      }
      if (
        // eslint-disable-next-line no-process-env
        process.env.LANGCHAIN_TRACING !== undefined &&
        !callbackManager.handlers.some(
          (handler) => handler.name === "langchain_tracer"
        )
      ) {
        callbackManager.addHandler(await getTracingCallbackHandler(), true);
      }
    }
    return callbackManager;
  }
}