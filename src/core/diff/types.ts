/**
 * Interface for implementing different diff strategies
 */

export interface DiffMetrics {
	executionTime: number
	memoryUsed: number
	accuracyScore: number
}

export interface DiffConflict {
	expected: string
	actual: string
	resolution: "auto" | "manual"
	lineNumber: number
}

export type DiffResult =
	| {
			success: true
			content: string
			metrics?: DiffMetrics
			appliedLines: number
	  }
	| {
			success: false
			error: string
			details?: {
				similarity?: number
				threshold?: number
				matchedRange?: { start: number; end: number }
				searchContent?: string
				bestMatch?: string
			}
			conflicts?: DiffConflict[]
	  }

export interface FileStats {
	size: number
	path: string
	language?: string
	lastModified: Date
}

export interface DiffStrategy {
	/**
	 * Get the tool description for this diff strategy
	 * @param args The tool arguments including cwd and toolOptions
	 * @returns The complete tool description including format requirements and examples
	 */
	getToolDescription(args: { cwd: string; toolOptions?: { [key: string]: string } }): string

	/**
	 * Apply a diff to the original content
	 * @param originalContent The original file content
	 * @param diffContent The diff content in the strategy's format
	 * @param startLine Optional line number where the search block starts. If not provided, searches the entire file.
	 * @param endLine Optional line number where the search block ends. If not provided, searches the entire file.
	 * @returns A DiffResult object containing either the successful result or error details
	 */
	applyDiff(
		originalContent: string,
		diffContent: string,
		options?: {
			startLine?: number
			endLine?: number
			fileStats?: FileStats
			collectMetrics?: boolean
		},
	): Promise<DiffResult>
}
