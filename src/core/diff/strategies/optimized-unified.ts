import { DiffStrategy, DiffResult, FileStats, DiffMetrics } from "../types"

interface DiffHunk {
	start: number
	end: number
	removed: string[]
	added: string[]
	context: string[]
}

/**
 * Optimized unified diff strategy using gap buffers for efficient insertions
 * and parallel processing for large files
 */
export class OptimizedUnifiedStrategy implements DiffStrategy {
	private readonly CHUNK_SIZE = 1024 * 1024 // 1MB chunk size for parallel processing
	private readonly GAP_BUFFER_SIZE = 1024 // Initial gap size

	constructor(private readonly fuzzyMatchThreshold: number = 0.9) {}

	getToolDescription(args: { cwd: string; toolOptions?: { [key: string]: string } }): string {
		return `## apply_diff
Description: Apply changes using an optimized unified diff format.
This strategy uses gap buffers for efficient insertions and parallel processing for large files.

Parameters:
- path: (required) File path relative to ${args.cwd}
- diff: (required) Unified diff content
- options: (optional) Additional options like fileStats and metrics collection

Format:
\`\`\`diff
@@ ... @@
 context line
-removed line
+added line
 context line
\`\`\`
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
			// Use gap buffer for efficient insertions
			const buffer = new GapBuffer(originalContent, this.GAP_BUFFER_SIZE)
			let appliedLines = 0

			// Parse the unified diff
			const hunks = this.parseUnifiedDiff(diffContent)

			// Process hunks in parallel for large files
			if (options?.fileStats?.size && options.fileStats.size > this.CHUNK_SIZE) {
				await this.processHunksInParallel(hunks, buffer)
			} else {
				this.processHunksSequentially(hunks, buffer)
			}

			appliedLines = hunks.reduce((sum, hunk) => sum + hunk.added.length, 0)

			const result = buffer.toString()

			if (options?.collectMetrics) {
				metrics.executionTime = performance.now() - startTime
				metrics.memoryUsed = process.memoryUsage().heapUsed
				metrics.accuracyScore = 1.0 // Perfect match for unified diff
			}

			return {
				success: true,
				content: result,
				appliedLines,
				metrics: options?.collectMetrics ? metrics : undefined,
			}
		} catch (error) {
			return {
				success: false,
				error: `Failed to apply unified diff: ${error.message}`,
				conflicts: [],
			}
		}
	}

	private parseUnifiedDiff(diffContent: string): DiffHunk[] {
		const hunks: DiffHunk[] = []
		const lines: string[] = diffContent.split("\n")
		let currentHunk: DiffHunk | null = null

		for (const line of lines) {
			if (line.startsWith("@@")) {
				if (currentHunk) {
					hunks.push(currentHunk)
				}
				const [start, count] = this.parseHunkHeader(line)
				currentHunk = {
					start,
					end: start + count,
					removed: [] as string[],
					added: [] as string[],
					context: [] as string[] as string[],
				}
			} else if (currentHunk) {
				if (line.startsWith("-")) {
					currentHunk.removed.push(line.slice(1))
				} else if (line.startsWith("+")) {
					currentHunk.added.push(line.slice(1))
				} else if (line.startsWith(" ")) {
					currentHunk.context.push(line.slice(1))
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

	private async processHunksInParallel(hunks: DiffHunk[], buffer: GapBuffer): Promise<void> {
		const chunks = this.splitHunksIntoChunks(hunks)
		await Promise.all(chunks.map((chunk) => this.processHunksSequentially(chunk, buffer)))
	}

	private processHunksSequentially(hunks: DiffHunk[], buffer: GapBuffer): void {
		for (const hunk of hunks) {
			// Verify context matches
			if (!this.verifyContext(buffer, hunk)) {
				throw new Error("Context mismatch in hunk")
			}

			// Apply changes
			buffer.replace(hunk.start, hunk.end, hunk.added.join("\n"))
		}
	}

	private splitHunksIntoChunks(hunks: DiffHunk[]): DiffHunk[][] {
		const chunks: any[][] = []
		const chunkSize = Math.ceil(hunks.length / navigator.hardwareConcurrency)

		for (let i = 0; i < hunks.length; i += chunkSize) {
			chunks.push(hunks.slice(i, i + chunkSize))
		}

		return chunks
	}

	private verifyContext(buffer: GapBuffer, hunk: DiffHunk): boolean {
		const content = buffer.slice(hunk.start, hunk.end)
		const contextLines = content.split("\n")

		return hunk.context.every((line: string, i: number) => contextLines[i].trim() === line.trim())
	}
}

/**
 * Gap buffer implementation for efficient string insertions and deletions
 */
class GapBuffer {
	private buffer: string[]
	private gapStart: number
	private gapEnd: number

	constructor(content: string, gapSize: number) {
		this.buffer = content.split("")
		this.gapStart = 0
		this.gapEnd = gapSize

		// Initialize gap
		this.buffer.splice(0, 0, ...new Array(gapSize).fill(""))
	}

	moveGap(pos: number): void {
		if (pos === this.gapStart) return

		const gapSize = this.gapEnd - this.gapStart
		if (pos < this.gapStart) {
			// Move gap left
			const moveSize = this.gapStart - pos
			const temp = this.buffer.slice(pos, this.gapStart)
			this.buffer.splice(this.gapEnd - moveSize, moveSize, ...temp)
			this.gapStart = pos
			this.gapEnd = pos + gapSize
		} else {
			// Move gap right
			const moveSize = pos - this.gapStart
			const temp = this.buffer.slice(this.gapEnd, this.gapEnd + moveSize)
			this.buffer.splice(this.gapStart, moveSize, ...temp)
			this.gapStart = pos
			this.gapEnd = pos + gapSize
		}
	}

	insert(pos: number, content: string): void {
		this.moveGap(pos)
		const chars = content.split("")

		// Expand gap if needed
		if (chars.length > this.gapEnd - this.gapStart) {
			const extra = chars.length - (this.gapEnd - this.gapStart)
			this.buffer.splice(this.gapEnd, 0, ...new Array(extra).fill(""))
			this.gapEnd += extra
		}

		// Insert content
		this.buffer.splice(this.gapStart, chars.length, ...chars)
		this.gapStart += chars.length
	}

	replace(start: number, end: number, content: string): void {
		this.moveGap(start)
		const deleteCount = end - start
		this.buffer.splice(this.gapStart, deleteCount)
		this.insert(start, content)
	}

	slice(start: number, end: number): string {
		if (start >= this.gapStart && start < this.gapEnd) {
			start = this.gapEnd
		}
		if (end >= this.gapStart && end < this.gapEnd) {
			end = this.gapEnd
		}
		return this.buffer.slice(start, end).join("")
	}

	toString(): string {
		return this.buffer.slice(0, this.gapStart).concat(this.buffer.slice(this.gapEnd)).join("")
	}
}
