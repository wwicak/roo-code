import type { DiffStrategy, FileStats } from "./types"
import { UnifiedDiffStrategy } from "./strategies/unified"
import { SearchReplaceDiffStrategy } from "./strategies/search-replace"
import { OptimizedUnifiedStrategy } from "./strategies/optimized-unified"
import { ParallelDiffStrategy } from "./strategies/parallel"
import { AstAwareStrategy } from "./strategies/ast-aware"
import { SmartHybridStrategy } from "./strategies/smart-hybrid"

const LARGE_FILE_THRESHOLD = 1024 * 1024 // 1MB

function hasAstSupport(filePath?: string): boolean {
	if (!filePath) return false
	const ext = filePath.split(".").pop()?.toLowerCase()
	return ["js", "jsx", "ts", "tsx", "go"].includes(ext || "")
}

/**
 * Get the appropriate diff strategy for the given model
 * @param model The name of the model being used (e.g., 'gpt-4', 'claude-3-opus')
 * @param fileStatsOrThreshold Optional file statistics to help determine the best strategy
 * @param fuzzyMatchThreshold Optional threshold for fuzzy matching
 * @param experimentalStrategy Optional flag to enable experimental strategies
 * @returns The appropriate diff strategy for the model
 */
export function getDiffStrategy(
	model: string,
	fileStatsOrThreshold?: FileStats | number,
	fuzzyMatchThreshold?: number,
	experimentalStrategy: boolean = false,
): DiffStrategy {
	// Handle legacy case where second param was fuzzyMatchThreshold
	const threshold = typeof fileStatsOrThreshold === "number" ? fileStatsOrThreshold : fuzzyMatchThreshold
	const fileStats = typeof fileStatsOrThreshold === "object" ? fileStatsOrThreshold : undefined

	// For large files, use parallel processing
	if (fileStats?.size && fileStats.size > LARGE_FILE_THRESHOLD) {
		return new ParallelDiffStrategy(threshold)
	}

	// For supported languages, use AST-aware diffing
	if (hasAstSupport(fileStats?.path)) {
		return new AstAwareStrategy(threshold)
	}

	// For normal files, use smart hybrid strategy for optimal performance
	if (fileStats?.size && fileStats.size <= LARGE_FILE_THRESHOLD) {
		// Use smart hybrid for JSON and text files that benefit from caching
		const ext = fileStats.path?.split(".").pop()?.toLowerCase()
		if (ext && ["json", "txt", "md", "yml", "yaml", "go"].includes(ext)) {
			return new SmartHybridStrategy()
		}
		// Fallback to optimized unified for other file types
		return new OptimizedUnifiedStrategy(threshold)
	}

	// Fallback to search/replace for maximum compatibility
	return new SearchReplaceDiffStrategy(threshold)
}

export {
	DiffStrategy,
	UnifiedDiffStrategy,
	SearchReplaceDiffStrategy,
	OptimizedUnifiedStrategy,
	ParallelDiffStrategy,
	AstAwareStrategy,
	SmartHybridStrategy,
}
