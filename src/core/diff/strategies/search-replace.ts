import { DiffStrategy, DiffResult, FileStats } from "../types"
import { addLineNumbers, everyLineHasLineNumbers, stripLineNumbers } from "../../../integrations/misc/extract-text"
import { distance } from "fastest-levenshtein"

const BUFFER_LINES = 20 // Number of extra context lines to show before and after matches
const MAX_CACHE_SIZE = 1000 // Maximum number of entries in LRU cache

// MurmurHash3 implementation for better hash distribution
function murmurHash3(str: string): number {
	const seed = 0x1234abcd
	const c1 = 0xcc9e2d51
	const c2 = 0x1b873593
	const r1 = 15
	const r2 = 13
	const m = 5
	const n = 0xe6546b64

	let hash = seed
	const chunks = Math.floor(str.length / 4)

	// Process 4 bytes at a time
	for (let i = 0; i < chunks; i++) {
		let k =
			(str.charCodeAt(i * 4) & 0xff) |
			((str.charCodeAt(i * 4 + 1) & 0xff) << 8) |
			((str.charCodeAt(i * 4 + 2) & 0xff) << 16) |
			((str.charCodeAt(i * 4 + 3) & 0xff) << 24)

		k = Math.imul(k, c1)
		k = (k << r1) | (k >>> (32 - r1))
		k = Math.imul(k, c2)

		hash ^= k
		hash = (hash << r2) | (hash >>> (32 - r2))
		hash = Math.imul(hash, m) + n
	}

	// Handle remaining bytes
	let k = 0
	const remaining = str.length - chunks * 4
	if (remaining > 0) {
		if (remaining >= 3) k ^= str.charCodeAt(str.length - 3) << 16
		if (remaining >= 2) k ^= str.charCodeAt(str.length - 2) << 8
		if (remaining >= 1) {
			k ^= str.charCodeAt(str.length - 1)
			k = Math.imul(k, c1)
			k = (k << r1) | (k >>> (32 - r1))
			k = Math.imul(k, c2)
			hash ^= k
		}
	}

	// Finalization
	hash ^= str.length
	hash ^= hash >>> 16
	hash = Math.imul(hash, 0x85ebca6b)
	hash ^= hash >>> 13
	hash = Math.imul(hash, 0xc2b2ae35)
	hash ^= hash >>> 16

	return hash >>> 0
}

// LRU Cache implementation
class LRUCache<K, V> {
	private cache: Map<K, V>
	private readonly maxSize: number

	constructor(maxSize: number) {
		this.cache = new Map()
		this.maxSize = maxSize
	}

	get(key: K): V | undefined {
		const value = this.cache.get(key)
		if (value !== undefined) {
			// Refresh item position
			this.cache.delete(key)
			this.cache.set(key, value)
		}
		return value
	}

	set(key: K, value: V): void {
		if (this.cache.size >= this.maxSize) {
			// Remove oldest entry (first item in map)
			const firstKey = this.cache.keys().next().value
			if (firstKey !== undefined) {
				this.cache.delete(firstKey)
			}
		}
		this.cache.set(key, value)
	}

	clear(): void {
		this.cache.clear()
	}

	get size(): number {
		return this.cache.size
	}
}

// Initialize LRU cache for similarity calculations
const similarityCache = new LRUCache<string, number>(MAX_CACHE_SIZE)

// WeakMap for storing normalized strings to reduce memory usage
const normalizedStrings = new WeakMap<object, string>()

function getSimilarity(original: string, search: string): number {
	if (search === "") {
		return 1
	}

	// Check cache first
	const cacheKey = `${original}|${search}`
	const cachedResult = similarityCache.get(cacheKey)
	if (cachedResult !== undefined) {
		return cachedResult
	}

	// Normalize strings efficiently
	const normalizeStr = (str: string): string => {
		const key = { str } // Create object key for WeakMap
		let normalized = normalizedStrings.get(key)
		if (!normalized) {
			normalized = str.replace(/\s+/g, " ").trim()
			normalizedStrings.set(key, normalized)
		}
		return normalized
	}

	const normalizedOriginal = normalizeStr(original)
	const normalizedSearch = normalizeStr(search)

	// Quick exact match check
	if (normalizedOriginal === normalizedSearch) {
		similarityCache.set(cacheKey, 1)
		return 1
	}

	// Hash comparison for quick rejection
	if (murmurHash3(normalizedOriginal) === murmurHash3(normalizedSearch)) {
		similarityCache.set(cacheKey, 1)
		return 1
	}

	// Calculate Levenshtein distance
	const dist = distance(normalizedOriginal, normalizedSearch)
	const maxLength = Math.max(normalizedOriginal.length, normalizedSearch.length)
	const similarity = 1 - dist / maxLength

	similarityCache.set(cacheKey, similarity)
	return similarity
}

export class SearchReplaceDiffStrategy implements DiffStrategy {
	private fuzzyThreshold: number
	private bufferLines: number

	constructor(fuzzyThreshold?: number, bufferLines?: number) {
		this.fuzzyThreshold = fuzzyThreshold ?? 1.0
		this.bufferLines = bufferLines ?? BUFFER_LINES
	}

	getToolDescription(args: { cwd: string; toolOptions?: { [key: string]: string } }): string {
		return `## apply_diff
Description: Request to replace existing code using a search and replace block.
This tool allows for precise, surgical replaces to files by specifying exactly what content to search for and what to replace it with.
The tool will maintain proper indentation and formatting while making changes.
Only a single operation is allowed per tool use.
The SEARCH section must exactly match existing content including whitespace and indentation.
If you're not confident in the exact content to search for, use the read_file tool first to get the exact content.
When applying the diffs, be extra careful to remember to change any closing brackets or other syntax that may be affected by the diff farther down in the file.

Parameters:
- path: (required) The path of the file to modify (relative to the current working directory ${args.cwd})
- diff: (required) The search/replace block defining the changes.
- start_line: (required) The line number where the search block starts.
- end_line: (required) The line number where the search block ends.

Diff format:
\`\`\`
<<<<<<< SEARCH
[exact content to find including whitespace]
=======
[new content to replace with]
>>>>>>> REPLACE
\`\`\`

Example:

Original file:
\`\`\`
1 | def calculate_total(items):
2 |     total = 0
3 |     for item in items:
4 |         total += item
5 |     return total
\`\`\`

Search/Replace content:
\`\`\`
<<<<<<< SEARCH
def calculate_total(items):
    total = 0
    for item in items:
        total += item
    return total
=======
def calculate_total(items):
    """Calculate total with 10% markup"""
    return sum(item * 1.1 for item in items)
>>>>>>> REPLACE
\`\`\`

Usage:
<apply_diff>
<path>File path here</path>
<diff>
Your search/replace content here
</diff>
<start_line>1</start_line>
<end_line>5</end_line>
</apply_diff>`
	}

	async applyDiff(
		originalContent: string,
		diffContent: string,
		options?: { startLine?: number; endLine?: number; fileStats?: FileStats; collectMetrics?: boolean },
	): Promise<DiffResult> {
		const startTime = options?.collectMetrics ? performance.now() : 0
		const startLine = options?.startLine
		const endLine = options?.endLine

		function escapeRegExp(string: string): string {
			return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		}

		const searchMarker = "<<<<<<< SEARCH"
		const dividerMarker = "======="
		const replaceMarker = ">>>>>>> REPLACE"

		const diffRegex = new RegExp(
			`${escapeRegExp(searchMarker)}\\r?\\n` +
				`([\\s\\S]*?)` +
				`\\r?\\n${escapeRegExp(dividerMarker)}\\r?\\n` +
				`([\\s\\S]*?)` +
				`\\r?\\n${escapeRegExp(replaceMarker)}`,
		)

		const match = diffContent.match(diffRegex)
		if (!match) {
			const contentPreview = diffContent.length > 200 ? diffContent.slice(0, 200) + "..." : diffContent

			const markers: string[] = []
			if (!diffContent.includes(searchMarker)) markers.push("Missing start marker '<<<<<<< SEARCH'")
			if (!diffContent.includes(dividerMarker)) markers.push("Missing divider '======='")
			if (!diffContent.includes(replaceMarker)) markers.push("Missing end marker '>>>>>>> REPLACE'")

			const missingMarkers =
				markers.length > 0
					? `\nMissing Markers:\n${markers.join("\n")}`
					: "\nAll markers present but in incorrect format"

			return {
				success: false,
				error: [
					`Invalid diff format - missing required SEARCH/REPLACE sections\n`,
					`Debug Info:`,
					`- Expected Format:`,
					`  ${searchMarker}`,
					`  [search content]`,
					`  ${dividerMarker}`,
					`  [replace content]`,
					`  ${replaceMarker}`,
					`- Tips:`,
					`  • Make sure markers are on their own lines`,
					`  • Check for extra/missing newlines`,
					`  • Verify exact marker spelling`,
					missingMarkers,
					`\nReceived Content:\n${contentPreview}`,
				].join("\n"),
			}
		}

		let [, searchContent = "", replaceContent = ""] = match

		const lineEnding = originalContent.includes("\r\n") ? "\r\n" : "\n"

		if (everyLineHasLineNumbers(searchContent) && everyLineHasLineNumbers(replaceContent)) {
			searchContent = stripLineNumbers(searchContent)
			replaceContent = stripLineNumbers(replaceContent)
		}

		const searchLines = searchContent === "" ? [] : searchContent.split(/\r?\n/)
		const replaceLines = replaceContent === "" ? [] : replaceContent.split(/\r?\n/)
		const originalLines = originalContent.split(/\r?\n/)

		if (searchLines.length === 0 && !startLine) {
			return {
				success: false,
				error: `Empty search content requires start_line to be specified\n\nDebug Info:\n- Empty search content is only valid for insertions at a specific line\n- For insertions, specify the line number where content should be inserted`,
			}
		}

		if (searchLines.length === 0 && startLine && endLine && startLine !== endLine) {
			return {
				success: false,
				error: `Empty search content requires start_line and end_line to be the same (got ${startLine}-${endLine})\n\nDebug Info:\n- Empty search content is only valid for insertions at a specific line\n- For insertions, use the same line number for both start_line and end_line`,
			}
		}

		let matchIndex = -1
		let bestMatchScore = 0
		let bestMatchContent = ""
		const searchChunk = searchLines.join("\n")

		let searchStartIndex = 0
		let searchEndIndex = originalLines.length

		if (startLine && endLine) {
			const exactStartIndex = startLine - 1
			const exactEndIndex = endLine - 1

			if (exactStartIndex < 0 || exactEndIndex > originalLines.length || exactStartIndex > exactEndIndex) {
				return {
					success: false,
					error: `Line range ${startLine}-${endLine} is invalid (file has ${originalLines.length} lines)\n\nDebug Info:\n- Requested Range: lines ${startLine}-${endLine}\n- File Bounds: lines 1-${originalLines.length}`,
				}
			}

			// Try exact match first
			const originalChunk = originalLines.slice(exactStartIndex, exactEndIndex + 1).join("\n")
			const similarity = getSimilarity(originalChunk, searchChunk)
			if (similarity >= this.fuzzyThreshold) {
				matchIndex = exactStartIndex
				bestMatchScore = similarity
				bestMatchContent = originalChunk
			} else {
				searchStartIndex = Math.max(0, startLine - (this.bufferLines + 1))
				searchEndIndex = Math.min(originalLines.length, endLine + this.bufferLines)
			}
		}

		if (matchIndex === -1) {
			const searchHash = murmurHash3(searchChunk)
			const windowSize = searchLines.length
			const maxIndex = searchEndIndex - windowSize + 1

			for (let i = searchStartIndex; i < maxIndex; i++) {
				const chunk = originalLines.slice(i, i + windowSize).join("\n")

				// Quick hash comparison
				if (murmurHash3(chunk) === searchHash) {
					matchIndex = i
					bestMatchScore = 1
					bestMatchContent = chunk
					break
				}

				// Detailed similarity check with early exit
				if (i % 3 === 0) {
					const similarity = getSimilarity(chunk, searchChunk)
					if (similarity > bestMatchScore) {
						bestMatchScore = similarity
						matchIndex = i
						bestMatchContent = chunk
					}

					if (bestMatchScore >= 0.95) {
						break
					}
				}
			}
		}

		if (matchIndex === -1 || bestMatchScore < this.fuzzyThreshold) {
			const originalContentSection =
				startLine !== undefined && endLine !== undefined
					? `\n\nOriginal Content:\n${addLineNumbers(
							originalLines
								.slice(
									Math.max(0, startLine - 1 - this.bufferLines),
									Math.min(originalLines.length, endLine + this.bufferLines),
								)
								.join("\n"),
							Math.max(1, startLine - this.bufferLines),
						)}`
					: `\n\nOriginal Content:\n${addLineNumbers(originalLines.join("\n"))}`

			const bestMatchSection = bestMatchContent
				? `\n\nBest Match Found:\n${addLineNumbers(bestMatchContent, matchIndex + 1)}`
				: `\n\nBest Match Found:\n(no match)`

			const lineRange =
				startLine || endLine
					? ` at ${startLine ? `start: ${startLine}` : "start"} to ${endLine ? `end: ${endLine}` : "end"}`
					: ""
			return {
				success: false,
				error: `No sufficiently similar match found${lineRange} (${Math.floor(bestMatchScore * 100)}% similar, needs ${Math.floor(this.fuzzyThreshold * 100)}%)\n\nDebug Info:\n- Similarity Score: ${Math.floor(bestMatchScore * 100)}%\n- Required Threshold: ${Math.floor(this.fuzzyThreshold * 100)}%\n- Search Range: ${startLine && endLine ? `lines ${startLine}-${endLine}` : "start to end"}\n- Tip: Use read_file to get the latest content of the file before attempting the diff again, as the file content may have changed\n\nSearch Content:\n${searchChunk}${bestMatchSection}${originalContentSection}`,
			}
		}

		const matchedLines = originalLines.slice(matchIndex, matchIndex + searchLines.length)

		const getIndent = (line: string): string => {
			const match = line.match(/^[\t ]*/)
			return match ? match[0] : ""
		}

		const originalIndent = getIndent(matchedLines[0] || "")
		const searchBaseIndent = getIndent(searchLines[0] || "")
		const searchBaseLevel = searchBaseIndent.length

		const indentedReplaceLines = replaceLines.map((line: string) => {
			const currentIndent = getIndent(line)
			const currentLevel = currentIndent.length
			const relativeLevel = currentLevel - searchBaseLevel

			let finalIndent: string
			if (relativeLevel < 0) {
				finalIndent = originalIndent.slice(0, Math.max(0, originalIndent.length + relativeLevel))
			} else {
				finalIndent = originalIndent + currentIndent.slice(searchBaseLevel)
			}

			return finalIndent + line.trim()
		})

		const finalParts = []
		if (matchIndex > 0) {
			finalParts.push(originalLines.slice(0, matchIndex).join(lineEnding))
		}
		finalParts.push(indentedReplaceLines.join(lineEnding))
		if (matchIndex + searchLines.length < originalLines.length) {
			finalParts.push(originalLines.slice(matchIndex + searchLines.length).join(lineEnding))
		}

		const finalContent = finalParts.join(lineEnding)

		return {
			success: true,
			content: finalContent,
			appliedLines: indentedReplaceLines.length,
			metrics: options?.collectMetrics
				? {
						executionTime: performance.now() - startTime,
						memoryUsed: process.memoryUsage().heapUsed,
						accuracyScore: bestMatchScore,
					}
				: undefined,
		}
	}
}
