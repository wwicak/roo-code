import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import {
	ApiHandlerOptions,
	ModelInfo,
	nvidiaDefaultModelId,
	openAiModelInfoSaneDefaults,
	nvidiaModels,
} from "../../shared/api"
import { ApiHandler, SingleCompletionHandler } from "../index"
import { convertToR1Format } from "../transform/r1-format"
import { ApiStream } from "../transform/stream"

export class NvidiaHandler implements ApiHandler, SingleCompletionHandler {
	protected options: ApiHandlerOptions
	private client: OpenAI

	constructor(options: ApiHandlerOptions) {
		this.options = options
		this.client = new OpenAI({
			baseURL: this.options.nvidiaBaseUrl ?? "https://integrate.api.nvidia.com/v1",
			apiKey: this.options.nvidiaApiKey,
		})
	}

	async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		const modelInfo = this.getModel().info
		const modelId = this.options.nvidiaModelId ?? nvidiaDefaultModelId

		if (this.options.nvidiaStreamingEnabled ?? true) {
			const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
				model: modelId,
				temperature: 0.6,
				top_p: 0.7,
				messages: convertToR1Format([{ role: "user", content: systemPrompt }, ...messages]),
				stream: true as const,
				stream_options: { include_usage: true },
			}
			if (this.options.includeMaxTokens) {
				requestOptions.max_tokens = modelInfo.maxTokens
			}

			const stream = await this.client.chat.completions.create(requestOptions)

			const startMarker = "<think>"
			const endMarker = "</think>"

			// Use single string buffer with index tracking
			let buffer = ""
			let lastEmitIndex = 0
			let isInReasoningBlock = false

			for await (const chunk of stream) {
				const chunkContent = chunk.choices[0]?.delta?.content || ""
				if (!chunkContent) continue

				buffer += chunkContent

				if (isInReasoningBlock) {
					const endPos = buffer.indexOf(endMarker, lastEmitIndex)
					if (endPos !== -1) {
						// Found complete reasoning block
						yield { type: "reasoning", text: buffer.substring(lastEmitIndex, endPos) }
						isInReasoningBlock = false
						lastEmitIndex = endPos + endMarker.length
					}
				} else {
					const startPos = buffer.indexOf(startMarker, lastEmitIndex)
					if (startPos !== -1) {
						// Found start of reasoning block
						if (startPos > 0) {
							yield { type: "text", text: buffer.substring(lastEmitIndex, startPos) }
						}
						isInReasoningBlock = true
						lastEmitIndex = startPos + startMarker.length
					} else {
						// Regular text, emit if we have enough content
						const safeLength = buffer.length - startMarker.length + 1
						if (safeLength > lastEmitIndex) {
							yield { type: "text", text: buffer.substring(lastEmitIndex, safeLength) }
							lastEmitIndex = safeLength
						}
					}
				}

				if (chunk.usage) {
					yield {
						type: "usage",
						inputTokens: chunk.usage.prompt_tokens || 0,
						outputTokens: chunk.usage.completion_tokens || 0,
					}
				}
			}

			// Emit any remaining content
			const remainingContent = buffer.substring(lastEmitIndex)
			if (remainingContent) {
				yield { type: isInReasoningBlock ? "reasoning" : "text", text: remainingContent }
			}
		} else {
			const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
				model: modelId,
				temperature: 0.6,
				top_p: 0.7,
				messages: convertToR1Format([{ role: "user", content: systemPrompt }, ...messages]),
			}

			const response = await this.client.chat.completions.create(requestOptions)
			const content = response.choices[0]?.message.content || ""

			// Handle reasoning blocks in non-streaming response
			const parts = content.split(/<think>|<\/think>/)
			for (let i = 0; i < parts.length; i++) {
				if (i % 2 === 0) {
					// Regular content
					if (parts[i]) {
						yield {
							type: "text",
							text: parts[i],
						}
					}
				} else {
					// Reasoning content
					if (parts[i]) {
						yield {
							type: "reasoning",
							text: parts[i],
						}
					}
				}
			}

			if (response.usage) {
				yield {
					type: "usage",
					inputTokens: response.usage.prompt_tokens || 0,
					outputTokens: response.usage.completion_tokens || 0,
				}
			}
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: this.options.nvidiaModelId ?? nvidiaDefaultModelId,
			info:
				this.options.nvidiaCustomModelInfo ?? nvidiaModels[nvidiaDefaultModelId] ?? openAiModelInfoSaneDefaults,
		}
	}

	async completePrompt(prompt: string): Promise<string> {
		try {
			const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
				model: this.getModel().id,
				messages: [{ role: "user", content: prompt }],
			}

			const response = await this.client.chat.completions.create(requestOptions)
			return response.choices[0]?.message.content || ""
		} catch (error) {
			if (error instanceof Error) {
				throw new Error(`NVIDIA completion error: ${error.message}`)
			}
			throw error
		}
	}
}
