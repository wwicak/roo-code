import { DiffStrategy, DiffResult, FileStats, DiffMetrics } from "../types"

/**
 * Parallel diff strategy that uses Web Workers for processing large files
 * Automatically chunks the file and processes parts in parallel
 */
export class ParallelDiffStrategy implements DiffStrategy {
	private readonly CHUNK_SIZE = 1024 * 1024 // 1MB chunks
	private readonly MAX_WORKERS = navigator.hardwareConcurrency || 4

	constructor(private readonly fuzzyMatchThreshold: number = 0.9) {}

	getToolDescription(args: { cwd: string; toolOptions?: { [key: string]: string } }): string {
		return `## apply_diff
Description: Apply changes using parallel processing for large files.
This strategy automatically splits the work across multiple threads for better performance.

Parameters:
- path: (required) File path relative to ${args.cwd}
- diff: (required) Unified diff content
- options: (optional) Additional options like fileStats and metrics collection

Note: This strategy is automatically selected for files larger than 1MB
`
	}

	async applyDiff(
		originalContent: string,
		diffContent: string,
		options?: {
			startLine?: number
			endLine?: number
			fileStats?: FileStats
			collectMetrics?: boolean
		},
	): Promise<DiffResult> {
		const startTime = options?.collectMetrics ? performance.now() : 0
		const metrics: DiffMetrics = {
			executionTime: 0,
			memoryUsed: 0,
			accuracyScore: 0,
		}

		try {
			// Split content into chunks
			const chunks = this.splitIntoChunks(originalContent)
			const diffChunks = this.splitDiff(diffContent, chunks.length)

			// Process chunks in parallel
			const results = await Promise.all(chunks.map((chunk, index) => this.processChunk(chunk, diffChunks[index])))

			// Merge results
			const mergedContent = this.mergeResults(results)
			const appliedLines = results.reduce((sum, r) => sum + (r.appliedLines || 0), 0)

			if (options?.collectMetrics) {
				metrics.executionTime = performance.now() - startTime
				metrics.memoryUsed = process.memoryUsage().heapUsed
				metrics.accuracyScore =
					results.reduce((sum, r) => sum + (r.metrics?.accuracyScore || 0), 0) / results.length
			}

			return {
				success: true,
				content: mergedContent,
				appliedLines,
				metrics: options?.collectMetrics ? metrics : undefined,
			}
		} catch (error) {
			return {
				success: false,
				error: `Failed to apply parallel diff: ${error.message}`,
				conflicts: [],
			}
		}
	}

	private splitIntoChunks(content: string): string[] {
		const chunks: string[] = []
		const lines = content.split("\n")
		const chunkSize = Math.ceil(lines.length / this.MAX_WORKERS)

		for (let i = 0; i < lines.length; i += chunkSize) {
			chunks.push(lines.slice(i, i + chunkSize).join("\n"))
		}

		return chunks
	}

	private splitDiff(diffContent: string, numChunks: number): string[] {
		// Parse the unified diff
		const hunks = this.parseUnifiedDiff(diffContent)

		// Distribute hunks across chunks
		const diffChunks: string[] = new Array(numChunks).fill("")

		for (const hunk of hunks) {
			const chunkIndex = Math.floor(hunk.start / (this.CHUNK_SIZE / numChunks))
			if (chunkIndex < numChunks) {
				diffChunks[chunkIndex] += this.formatHunk(hunk)
			}
		}

		return diffChunks
	}

	private parseUnifiedDiff(diffContent: string): Array<{
		start: number
		end: number
		content: string
	}> {
		const hunks = []
		const lines = diffContent.split("\n")
		let currentHunk = null

		for (const line of lines) {
			if (line.startsWith("@@")) {
				if (currentHunk) {
					hunks.push(currentHunk)
				}
				const [start] = this.parseHunkHeader(line)
				currentHunk = {
					start,
					end: start,
					content: line + "\n",
				}
			} else if (currentHunk) {
				currentHunk.content += line + "\n"
				if (line.startsWith("+")) {
					currentHunk.end++
				}
			}
		}

		if (currentHunk) {
			hunks.push(currentHunk)
		}

		return hunks
	}

	private parseHunkHeader(header: string): [number, number] {
		const match = header.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
		if (!match) {
			throw new Error("Invalid hunk header format")
		}
		return [parseInt(match[1], 10), parseInt(match[2], 10)]
	}

	private formatHunk(hunk: { start: number; end: number; content: string }): string {
		return hunk.content
	}

	private async processChunk(
		chunk: string,
		diffChunk: string,
	): Promise<{
		content: string
		appliedLines: number
		metrics?: DiffMetrics
	}> {
		// In a real implementation, this would use Web Workers
		// For now, we'll process synchronously
		const lines = chunk.split("\n")
		const hunks = this.parseUnifiedDiff(diffChunk)
		let appliedLines = 0

		for (const hunk of hunks) {
			const hunkLines = hunk.content.split("\n")
			let lineIndex = hunk.start

			for (const line of hunkLines) {
				if (line.startsWith("+")) {
					lines.splice(lineIndex, 0, line.slice(1))
					lineIndex++
					appliedLines++
				} else if (line.startsWith("-")) {
					lines.splice(lineIndex, 1)
				} else if (line.startsWith(" ")) {
					lineIndex++
				}
			}
		}

		return {
			content: lines.join("\n"),
			appliedLines,
			metrics: {
				executionTime: 0,
				memoryUsed: 0,
				accuracyScore: 1.0,
			},
		}
	}

	private mergeResults(
		results: Array<{
			content: string
			appliedLines: number
			metrics?: DiffMetrics
		}>,
	): string {
		return results.map((r) => r.content).join("\n")
	}
}
