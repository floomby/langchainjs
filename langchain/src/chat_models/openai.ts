import {
  Configuration,
  OpenAIApi,
  CreateChatCompletionRequest,
  ConfigurationParameters,
  CreateChatCompletionResponse,
  ChatCompletionResponseMessageRoleEnum,
  ChatCompletionRequestMessage,
} from "openai";
import { getEnvironmentVariable, isNode } from "../util/env.js";
import {
  AzureOpenAIInput,
  OpenAICallOptions,
  OpenAIChatInput,
} from "../types/openai-types.js";
import fetchAdapter from "../util/axios-fetch-adapter.js";
import type { StreamingAxiosConfiguration } from "../util/axios-types.js";
import { BaseChatModel, BaseChatModelParams } from "./base.js";
import {
  AIChatMessage,
  BaseChatMessage,
  ChatGeneration,
  ChatMessage,
  ChatResult,
  HumanChatMessage,
  MessageType,
  SystemChatMessage,
} from "../schema/index.js";
import { getModelNameForTiktoken } from "../base_language/count_tokens.js";
import { CallbackManagerForLLMRun } from "../callbacks/manager.js";
import { promptLayerTrackRequest } from "../util/prompt-layer.js";

export { OpenAICallOptions, OpenAIChatInput, AzureOpenAIInput };

interface TokenUsage {
  completionTokens?: number;
  promptTokens?: number;
  totalTokens?: number;
}

interface OpenAILLMOutput {
  tokenUsage: TokenUsage;
}

function messageTypeToOpenAIRole(
  type: MessageType
): ChatCompletionResponseMessageRoleEnum {
  switch (type) {
    case "system":
      return "system";
    case "ai":
      return "assistant";
    case "human":
      return "user";
    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}

function openAIResponseToChatMessage(
  role: ChatCompletionResponseMessageRoleEnum | undefined,
  text: string
): BaseChatMessage {
  switch (role) {
    case "user":
      return new HumanChatMessage(text);
    case "assistant":
      return new AIChatMessage(text);
    case "system":
      return new SystemChatMessage(text);
    default:
      return new ChatMessage(text, role ?? "unknown");
  }
}

/**
 * Wrapper around OpenAI large language models that use the Chat endpoint.
 *
 * To use you should have the `openai` package installed, with the
 * `OPENAI_API_KEY` environment variable set.
 *
 * To use with Azure you should have the `openai` package installed, with the
 * `AZURE_OPENAI_API_KEY`,
 * `AZURE_OPENAI_API_INSTANCE_NAME`,
 * `AZURE_OPENAI_API_DEPLOYMENT_NAME`
 * and `AZURE_OPENAI_API_VERSION` environment variable set.
 *
 * @remarks
 * Any parameters that are valid to be passed to {@link
 * https://platform.openai.com/docs/api-reference/chat/create |
 * `openai.createCompletion`} can be passed through {@link modelKwargs}, even
 * if not explicitly available on this class.
 */
export class ChatOpenAI
  extends BaseChatModel
  implements OpenAIChatInput, AzureOpenAIInput
{
  declare CallOptions: OpenAICallOptions;

  get callKeys(): (keyof OpenAICallOptions)[] {
    return ["stop", "signal", "timeout", "options"];
  }

  lc_serializable = true;

  get lc_secrets(): { [key: string]: string } | undefined {
    return {
      openAIApiKey: "OPENAI_API_KEY",
      azureOpenAIApiKey: "AZURE_OPENAI_API_KEY",
    };
  }

  get lc_aliases(): Record<string, string> {
    return {
      modelName: "model",
      openAIApiKey: "openai_api_key",
      azureOpenAIApiVersion: "azure_openai_api_version",
      azureOpenAIApiKey: "azure_openai_api_key",
      azureOpenAIApiInstanceName: "azure_openai_api_instance_name",
      azureOpenAIApiDeploymentName: "azure_openai_api_deployment_name",
    };
  }

  temperature = 1;

  topP = 1;

  frequencyPenalty = 0;

  presencePenalty = 0;

  n = 1;

  logitBias?: Record<string, number>;

  modelName = "gpt-3.5-turbo";

  modelKwargs?: OpenAIChatInput["modelKwargs"];

  stop?: string[];

  timeout?: number;

  streaming = false;

  maxTokens?: number;

  azureOpenAIApiVersion?: string;

  azureOpenAIApiKey?: string;

  azureOpenAIApiInstanceName?: string;

  azureOpenAIApiDeploymentName?: string;

  private client: OpenAIApi;

  private clientConfig: ConfigurationParameters;

  constructor(
    fields?: Partial<OpenAIChatInput> &
      Partial<AzureOpenAIInput> &
      BaseChatModelParams & {
        concurrency?: number;
        cache?: boolean;
        openAIApiKey?: string;
        configuration?: ConfigurationParameters;
      },
    /** @deprecated */
    configuration?: ConfigurationParameters
  ) {
    super(fields ?? {});

    const apiKey =
      fields?.openAIApiKey ?? getEnvironmentVariable("OPENAI_API_KEY");

    const azureApiKey =
      fields?.azureOpenAIApiKey ??
      getEnvironmentVariable("AZURE_OPENAI_API_KEY");
    if (!azureApiKey && !apiKey) {
      throw new Error("(Azure) OpenAI API key not found");
    }

    const azureApiInstanceName =
      fields?.azureOpenAIApiInstanceName ??
      getEnvironmentVariable("AZURE_OPENAI_API_INSTANCE_NAME");

    const azureApiDeploymentName =
      fields?.azureOpenAIApiDeploymentName ??
      getEnvironmentVariable("AZURE_OPENAI_API_DEPLOYMENT_NAME");

    const azureApiVersion =
      fields?.azureOpenAIApiVersion ??
      getEnvironmentVariable("AZURE_OPENAI_API_VERSION");

    this.modelName = fields?.modelName ?? this.modelName;
    this.modelKwargs = fields?.modelKwargs ?? {};
    this.timeout = fields?.timeout;

    this.temperature = fields?.temperature ?? this.temperature;
    this.topP = fields?.topP ?? this.topP;
    this.frequencyPenalty = fields?.frequencyPenalty ?? this.frequencyPenalty;
    this.presencePenalty = fields?.presencePenalty ?? this.presencePenalty;
    this.maxTokens = fields?.maxTokens;
    this.n = fields?.n ?? this.n;
    this.logitBias = fields?.logitBias;
    this.stop = fields?.stop;

    this.streaming = fields?.streaming ?? false;

    this.azureOpenAIApiVersion = azureApiVersion;
    this.azureOpenAIApiKey = azureApiKey;
    this.azureOpenAIApiInstanceName = azureApiInstanceName;
    this.azureOpenAIApiDeploymentName = azureApiDeploymentName;

    if (this.streaming && this.n > 1) {
      throw new Error("Cannot stream results when n > 1");
    }

    if (this.azureOpenAIApiKey) {
      if (!this.azureOpenAIApiInstanceName) {
        throw new Error("Azure OpenAI API instance name not found");
      }
      if (!this.azureOpenAIApiDeploymentName) {
        throw new Error("Azure OpenAI API deployment name not found");
      }
      if (!this.azureOpenAIApiVersion) {
        throw new Error("Azure OpenAI API version not found");
      }
    }

    this.clientConfig = {
      apiKey,
      ...configuration,
      ...fields?.configuration,
    };
  }

  /**
   * Get the parameters used to invoke the model
   */
  invocationParams(): Omit<CreateChatCompletionRequest, "messages"> {
    return {
      model: this.modelName,
      temperature: this.temperature,
      top_p: this.topP,
      frequency_penalty: this.frequencyPenalty,
      presence_penalty: this.presencePenalty,
      max_tokens: this.maxTokens === -1 ? undefined : this.maxTokens,
      n: this.n,
      logit_bias: this.logitBias,
      stop: this.stop,
      stream: this.streaming,
      ...this.modelKwargs,
    };
  }

  /** @ignore */
  _identifyingParams() {
    return {
      model_name: this.modelName,
      ...this.invocationParams(),
      ...this.clientConfig,
    };
  }

  /**
   * Get the identifying parameters for the model
   */
  identifyingParams() {
    return this._identifyingParams();
  }

  /** @ignore */
  async _generate(
    messages: BaseChatMessage[],
    options?: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    const tokenUsage: TokenUsage = {};
    if (this.stop && options?.stop) {
      throw new Error("Stop found in input and default params");
    }

    const params = this.invocationParams();
    params.stop = options?.stop ?? params.stop;
    const messagesMapped: ChatCompletionRequestMessage[] = messages.map(
      (message) => ({
        role: messageTypeToOpenAIRole(message._getType()),
        content: message.text,
        name: message.name,
      })
    );

    const data = params.stream
      ? await new Promise<CreateChatCompletionResponse>((resolve, reject) => {
          let response: CreateChatCompletionResponse;
          let rejected = false;
          let resolved = false;
          this.completionWithRetry(
            {
              ...params,
              messages: messagesMapped,
            },
            {
              signal: options?.signal,
              ...options?.options,
              adapter: fetchAdapter, // default adapter doesn't do streaming
              responseType: "stream",
              onmessage: (event) => {
                if (event.data?.trim?.() === "[DONE]") {
                  if (resolved) {
                    return;
                  }
                  resolved = true;
                  resolve(response);
                } else {
                  const message = JSON.parse(event.data) as {
                    id: string;
                    object: string;
                    created: number;
                    model: string;
                    choices: Array<{
                      index: number;
                      finish_reason: string | null;
                      delta: { content?: string; role?: string };
                    }>;
                  };

                  // on the first message set the response properties
                  if (!response) {
                    response = {
                      id: message.id,
                      object: message.object,
                      created: message.created,
                      model: message.model,
                      choices: [],
                    };
                  }

                  // on all messages, update choice
                  for (const part of message.choices) {
                    if (part != null) {
                      let choice = response.choices.find(
                        (c) => c.index === part.index
                      );

                      if (!choice) {
                        choice = {
                          index: part.index,
                          finish_reason: part.finish_reason ?? undefined,
                        };
                        response.choices[part.index] = choice;
                      }

                      if (!choice.message) {
                        choice.message = {
                          role: part.delta
                            ?.role as ChatCompletionResponseMessageRoleEnum,
                          content: part.delta?.content ?? "",
                        };
                      }

                      choice.message.content += part.delta?.content ?? "";
                      // TODO this should pass part.index to the callback
                      // when that's supported there
                      // eslint-disable-next-line no-void
                      void runManager?.handleLLMNewToken(
                        part.delta?.content ?? ""
                      );
                    }
                  }

                  // when all messages are finished, resolve
                  if (
                    !resolved &&
                    message.choices.every((c) => c.finish_reason != null)
                  ) {
                    resolved = true;
                    resolve(response);
                  }
                }
              },
            }
          ).catch((error) => {
            if (!rejected) {
              rejected = true;
              reject(error);
            }
          });
        })
      : await this.completionWithRetry(
          {
            ...params,
            messages: messagesMapped,
          },
          {
            signal: options?.signal,
            ...options?.options,
          }
        );

    const {
      completion_tokens: completionTokens,
      prompt_tokens: promptTokens,
      total_tokens: totalTokens,
    } = data.usage ?? {};

    if (completionTokens) {
      tokenUsage.completionTokens =
        (tokenUsage.completionTokens ?? 0) + completionTokens;
    }

    if (promptTokens) {
      tokenUsage.promptTokens = (tokenUsage.promptTokens ?? 0) + promptTokens;
    }

    if (totalTokens) {
      tokenUsage.totalTokens = (tokenUsage.totalTokens ?? 0) + totalTokens;
    }

    const generations: ChatGeneration[] = [];
    for (const part of data.choices) {
      const role = part.message?.role ?? undefined;
      const text = part.message?.content ?? "";
      generations.push({
        text,
        message: openAIResponseToChatMessage(role, text),
      });
    }
    return {
      generations,
      llmOutput: { tokenUsage },
    };
  }

  async getNumTokensFromMessages(messages: BaseChatMessage[]): Promise<{
    totalCount: number;
    countPerMessage: number[];
  }> {
    let totalCount = 0;
    let tokensPerMessage = 0;
    let tokensPerName = 0;

    // From: https://github.com/openai/openai-cookbook/blob/main/examples/How_to_format_inputs_to_ChatGPT_models.ipynb
    if (getModelNameForTiktoken(this.modelName) === "gpt-3.5-turbo") {
      tokensPerMessage = 4;
      tokensPerName = -1;
    } else if (getModelNameForTiktoken(this.modelName).startsWith("gpt-4")) {
      tokensPerMessage = 3;
      tokensPerName = 1;
    }

    const countPerMessage = await Promise.all(
      messages.map(async (message) => {
        const textCount = await this.getNumTokens(message.text);
        const roleCount = await this.getNumTokens(
          messageTypeToOpenAIRole(message._getType())
        );
        const nameCount =
          message.name !== undefined
            ? tokensPerName + (await this.getNumTokens(message.name))
            : 0;
        const count = textCount + tokensPerMessage + roleCount + nameCount;

        totalCount += count;
        return count;
      })
    );

    totalCount += 3; // every reply is primed with <|start|>assistant<|message|>

    return { totalCount, countPerMessage };
  }

  /** @ignore */
  async completionWithRetry(
    request: CreateChatCompletionRequest,
    options?: StreamingAxiosConfiguration
  ) {
    if (!this.client) {
      const endpoint = this.azureOpenAIApiKey
        ? `https://${this.azureOpenAIApiInstanceName}.openai.azure.com/openai/deployments/${this.azureOpenAIApiDeploymentName}`
        : this.clientConfig.basePath;
      const clientConfig = new Configuration({
        ...this.clientConfig,
        basePath: endpoint,
        baseOptions: {
          timeout: this.timeout,
          ...this.clientConfig.baseOptions,
        },
      });
      this.client = new OpenAIApi(clientConfig);
    }
    const axiosOptions = {
      adapter: isNode() ? undefined : fetchAdapter,
      ...this.clientConfig.baseOptions,
      ...options,
    } as StreamingAxiosConfiguration;
    if (this.azureOpenAIApiKey) {
      axiosOptions.headers = {
        "api-key": this.azureOpenAIApiKey,
        ...axiosOptions.headers,
      };
      axiosOptions.params = {
        "api-version": this.azureOpenAIApiVersion,
        ...axiosOptions.params,
      };
    }
    return this.caller
      .call(
        this.client.createChatCompletion.bind(this.client),
        request,
        axiosOptions
      )
      .then((res) => res.data);
  }

  _llmType() {
    return "openai";
  }

  /** @ignore */
  _combineLLMOutput(...llmOutputs: OpenAILLMOutput[]): OpenAILLMOutput {
    return llmOutputs.reduce<{
      [key in keyof OpenAILLMOutput]: Required<OpenAILLMOutput[key]>;
    }>(
      (acc, llmOutput) => {
        if (llmOutput && llmOutput.tokenUsage) {
          acc.tokenUsage.completionTokens +=
            llmOutput.tokenUsage.completionTokens ?? 0;
          acc.tokenUsage.promptTokens += llmOutput.tokenUsage.promptTokens ?? 0;
          acc.tokenUsage.totalTokens += llmOutput.tokenUsage.totalTokens ?? 0;
        }
        return acc;
      },
      {
        tokenUsage: {
          completionTokens: 0,
          promptTokens: 0,
          totalTokens: 0,
        },
      }
    );
  }
}

export class PromptLayerChatOpenAI extends ChatOpenAI {
  promptLayerApiKey?: string;

  plTags?: string[];

  returnPromptLayerId?: boolean;

  constructor(
    fields?: ConstructorParameters<typeof ChatOpenAI>[0] & {
      promptLayerApiKey?: string;
      plTags?: string[];
      returnPromptLayerId?: boolean;
    }
  ) {
    super(fields);

    this.promptLayerApiKey =
      fields?.promptLayerApiKey ??
      (typeof process !== "undefined"
        ? // eslint-disable-next-line no-process-env
          process.env?.PROMPTLAYER_API_KEY
        : undefined);
    this.plTags = fields?.plTags ?? [];
    this.returnPromptLayerId = fields?.returnPromptLayerId ?? false;
  }

  async _generate(
    messages: BaseChatMessage[],
    options?: string[] | this["CallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    const requestStartTime = Date.now();

    let parsedOptions: this["CallOptions"];
    if (Array.isArray(options)) {
      parsedOptions = { stop: options } as this["CallOptions"];
    } else if (options?.timeout && !options.signal) {
      parsedOptions = {
        ...options,
        signal: AbortSignal.timeout(options.timeout),
      };
    } else {
      parsedOptions = options ?? {};
    }

    const generatedResponses = await super._generate(
      messages,
      parsedOptions,
      runManager
    );
    const requestEndTime = Date.now();

    const _convertMessageToDict = (message: BaseChatMessage) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let messageDict: Record<string, any>;

      if (message._getType() === "human") {
        messageDict = { role: "user", content: message.text };
      } else if (message._getType() === "ai") {
        messageDict = { role: "assistant", content: message.text };
      } else if (message._getType() === "system") {
        messageDict = { role: "system", content: message.text };
      } else if (message._getType() === "generic") {
        messageDict = {
          role: (message as ChatMessage).role,
          content: message.text,
        };
      } else {
        throw new Error(`Got unknown type ${message}`);
      }

      return messageDict;
    };

    const _createMessageDicts = (
      messages: BaseChatMessage[],
      callOptions?: this["CallOptions"]
    ) => {
      const params = {
        ...this.invocationParams(),
        model: this.modelName,
      };

      if (callOptions?.stop) {
        if (Object.keys(params).includes("stop")) {
          throw new Error("`stop` found in both the input and default params.");
        }
      }
      const messageDicts = messages.map((message) =>
        _convertMessageToDict(message)
      );
      return messageDicts;
    };

    for (let i = 0; i < generatedResponses.generations.length; i += 1) {
      const generation = generatedResponses.generations[i];
      const messageDicts = _createMessageDicts(messages, parsedOptions);

      let promptLayerRequestId: string | undefined;
      const parsedResp = [
        {
          content: generation.text,
          role: messageTypeToOpenAIRole(generation.message._getType()),
        },
      ];

      const promptLayerRespBody = await promptLayerTrackRequest(
        this.caller,
        "langchain.PromptLayerChatOpenAI",
        messageDicts,
        this._identifyingParams(),
        this.plTags,
        parsedResp,
        requestStartTime,
        requestEndTime,
        this.promptLayerApiKey
      );

      if (this.returnPromptLayerId === true) {
        if (promptLayerRespBody.success === true) {
          promptLayerRequestId = promptLayerRespBody.request_id;
        }

        if (
          !generation.generationInfo ||
          typeof generation.generationInfo !== "object"
        ) {
          generation.generationInfo = {};
        }

        generation.generationInfo.promptLayerRequestId = promptLayerRequestId;
      }
    }

    return generatedResponses;
  }
}
