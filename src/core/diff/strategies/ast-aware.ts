import { DiffStrategy, DiffResult, FileStats, DiffMetrics } from "../types"
import * as parser from "@babel/parser"
import traverse, { NodePath } from "@babel/traverse"
import generate from "@babel/generator"
import * as t from "@babel/types"
import crypto from "crypto"

interface AstMetrics extends DiffMetrics {
	nodeMatchAccuracy: number
	structuralComplexity: number
	cacheHitRate: number
}

interface NodeSignature {
	type: string
	hash: string
	children: NodeSignature[]
}

interface NodeMatch {
	node: t.Node
	similarity: number
	matchedPaths: string[]
}

interface ValidationResult {
	isValid: boolean
	errors: Array<{
		path: string[]
		message: string
		severity: "error" | "warning"
	}>
}

type ChangeType = "insert" | "update" | "delete"

interface AstChange {
	type: ChangeType
	path: string[]
	value?: string
	signature?: NodeSignature
}

interface AstModificationResult {
	ast: t.File
	appliedChanges: number
	metrics?: AstMetrics
}

// LRU Cache for AST parsing results
class AstCache {
	private cache: Map<string, { ast: t.File; lastUsed: number }>
	private readonly maxSize: number

	constructor(maxSize = 50) {
		this.cache = new Map()
		this.maxSize = maxSize
	}

	get(content: string): t.File | undefined {
		const hash = this.hashContent(content)
		const entry = this.cache.get(hash)
		if (entry) {
			entry.lastUsed = Date.now()
			return entry.ast
		}
		return undefined
	}

	set(content: string, ast: t.File): void {
		if (this.cache.size >= this.maxSize) {
			// Evict least recently used entry
			let oldest = Date.now()
			let oldestKey = ""
			this.cache.forEach((entry, key) => {
				if (entry.lastUsed < oldest) {
					oldest = entry.lastUsed
					oldestKey = key
				}
			})
			if (oldestKey) {
				this.cache.delete(oldestKey)
			}
		}
		this.cache.set(this.hashContent(content), {
			ast,
			lastUsed: Date.now(),
		})
	}

	private hashContent(content: string): string {
		return crypto.createHash("sha256").update(content).digest("hex")
	}
}

/**
 * Enhanced AST-aware diff strategy that uses intelligent node matching
 * and caching for efficient code modifications
 */
export class AstAwareStrategy implements DiffStrategy {
	private readonly astCache: AstCache
	private metrics: AstMetrics

	constructor(
		private readonly fuzzyMatchThreshold: number = 0.9,
		private readonly maxCacheSize: number = 50,
	) {
		this.astCache = new AstCache(maxCacheSize)
		this.metrics = this.initializeMetrics()
	}

	private initializeMetrics(): AstMetrics {
		return {
			executionTime: 0,
			memoryUsed: 0,
			accuracyScore: 0,
			nodeMatchAccuracy: 0,
			structuralComplexity: 0,
			cacheHitRate: 0,
		}
	}

	getToolDescription(args: { cwd: string; toolOptions?: { [key: string]: string } }): string {
		return `## apply_diff
Description: Apply changes using intelligent AST-aware parsing for precise code modifications.
This strategy understands code structure, maintains syntax correctness, and optimizes performance through caching.

Parameters:
- path: (required) File path relative to ${args.cwd}
- diff: (required) Unified diff content
- options: (optional) Additional options like fileStats and metrics collection

Features:
- Structural node matching
- Intelligent fuzzy matching
- Performance optimization through caching
- Detailed metrics collection
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
		this.metrics = this.initializeMetrics()

		try {
			const language = this.detectLanguage(options?.fileStats?.path)
			if (!this.isLanguageSupported(language)) {
				throw new Error(`Language ${language} is not supported for AST-aware diffing`)
			}

			// Try to get AST from cache
			let ast = this.astCache.get(originalContent)
			let cacheHit = !!ast

			if (!ast) {
				ast = this.parseToAst(originalContent, language)
				this.astCache.set(originalContent, ast)
			}

			// Generate signatures for original AST
			const originalSignatures = this.generateNodeSignatures(ast)

			// Parse and validate changes
			const changes = this.parseDiffToAstChanges(diffContent)
			const validation = this.validateChanges(changes, ast)

			if (!validation.isValid) {
				throw new Error(
					`Invalid AST changes: ${validation.errors
						.map((e) => `${e.message} at ${e.path.join(".")}`)
						.join(", ")}`,
				)
			}

			// Apply changes with intelligent node matching
			const {
				ast: modifiedAst,
				appliedChanges,
				metrics,
			} = await this.applyAstChanges(ast, changes, originalSignatures)

			// Generate the modified code
			const { code } = generate(modifiedAst, {
				retainLines: true,
				compact: false,
				jsescOption: {
					minimal: true,
				},
			})

			if (options?.collectMetrics) {
				this.metrics.executionTime = performance.now() - startTime
				this.metrics.memoryUsed = process.memoryUsage().heapUsed
				this.metrics.cacheHitRate = cacheHit ? 1 : 0
				Object.assign(this.metrics, metrics)
			}

			return {
				success: true,
				content: code,
				appliedLines: appliedChanges,
				metrics: options?.collectMetrics ? this.metrics : undefined,
			}
		} catch (error) {
			return {
				success: false,
				error: `Failed to apply AST-aware diff: ${error instanceof Error ? error.message : String(error)}`,
				conflicts: [],
			}
		}
	}

	private detectLanguage(filePath?: string): string {
		if (!filePath) return "javascript"

		const extension = filePath.split(".").pop()?.toLowerCase()
		switch (extension) {
			case "js":
			case "jsx":
				return "javascript"
			case "ts":
			case "tsx":
				return "typescript"
			default:
				return "unknown"
		}
	}

	private isLanguageSupported(language: string): boolean {
		return ["javascript", "typescript"].includes(language)
	}

	private parseToAst(content: string, language: string): t.File {
		const plugins: parser.ParserPlugin[] = []

		if (language === "typescript") {
			plugins.push("typescript")
			plugins.push("jsx")
		} else {
			plugins.push("jsx")
		}

		return parser.parse(content, {
			sourceType: "module",
			plugins,
		})
	}

	private getNodeContent(node: t.Node): string {
		if (t.isIdentifier(node)) return node.name
		if (t.isStringLiteral(node)) return node.value
		if (t.isNumericLiteral(node)) return String(node.value)
		if (t.isBooleanLiteral(node)) return String(node.value)
		return node.type
	}

	private generateNodeSignatures(node: t.Node): NodeSignature {
		const signature: NodeSignature = {
			type: node.type,
			hash: "",
			children: [],
		}

		// Generate signatures for children
		const childSignatures: NodeSignature[] = []
		traverse(t.file(t.program([t.expressionStatement(node as any)])), {
			enter: (path: NodePath) => {
				if (path.node !== node) {
					childSignatures.push(this.generateNodeSignatures(path.node))
				}
			},
		})
		signature.children = childSignatures

		// Generate hash including children
		const content = signature.type + this.getNodeContent(node) + signature.children.map((c) => c.hash).join("")

		signature.hash = crypto.createHash("sha256").update(content).digest("hex")

		return signature
	}

	private calculateNodeSimilarity(node1: t.Node, node2: t.Node): number {
		const sig1 = this.generateNodeSignatures(node1)
		const sig2 = this.generateNodeSignatures(node2)

		// Compare structure
		const structuralMatch = sig1.type === sig2.type ? 0.5 : 0

		// Compare content similarity
		const contentSimilarity = this.calculateStringSimilarity(sig1.hash, sig2.hash)

		return structuralMatch + contentSimilarity * 0.5
	}

	private calculateStringSimilarity(str1: string, str2: string): number {
		const longer = str1.length > str2.length ? str1 : str2
		const shorter = str1.length > str2.length ? str2 : str1

		if (longer.length === 0) return 1.0

		const costs: number[] = []
		for (let i = 0; i <= shorter.length; i++) {
			let lastValue = i
			for (let j = 0; j <= longer.length; j++) {
				if (i === 0) {
					costs[j] = j
				} else {
					if (j > 0) {
						let newValue = costs[j - 1]
						if (shorter[i - 1] !== longer[j - 1]) {
							newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1
						}
						costs[j - 1] = lastValue
						lastValue = newValue
					}
				}
			}
			if (i > 0) costs[longer.length] = lastValue
		}
		return (longer.length - costs[longer.length]) / longer.length
	}

	private parseDiffToAstChanges(diffContent: string): AstChange[] {
		const changes: AstChange[] = []
		const lines = diffContent.split("\n")
		let currentHunk: [number, number] | null = null

		for (const line of lines) {
			if (line.startsWith("@@")) {
				currentHunk = this.parseHunkHeader(line)
			} else if (currentHunk) {
				const change = this.parseChangeLine(line, currentHunk)
				if (change) changes.push(change)
			}
		}

		return changes
	}

	private parseChangeLine(line: string, hunk: [number, number]): AstChange | null {
		if (line.startsWith("+")) {
			return {
				type: "insert",
				path: ["body", hunk[0].toString()],
				value: line.slice(1),
			}
		} else if (line.startsWith("-")) {
			return {
				type: "delete",
				path: ["body", hunk[0].toString()],
			}
		}
		return null
	}

	private parseHunkHeader(header: string): [number, number] {
		const match = header.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
		if (!match) {
			throw new Error("Invalid hunk header format")
		}
		return [parseInt(match[1], 10), parseInt(match[2], 10)]
	}

	private validateChanges(changes: AstChange[], ast: t.File): ValidationResult {
		const errors: ValidationResult["errors"] = []

		for (const change of changes) {
			try {
				if (change.value && change.type !== "delete") {
					// Validate new code can be parsed
					parser.parse(change.value, {
						sourceType: "module",
					})
				}

				// Validate path exists for updates/deletes
				if (change.type !== "insert") {
					let current: any = ast
					for (const segment of change.path) {
						if (!current[segment]) {
							errors.push({
								path: change.path,
								message: `Invalid path segment: ${segment}`,
								severity: "error",
							})
							break
						}
						current = current[segment]
					}
				}
			} catch (error) {
				errors.push({
					path: change.path,
					message: error instanceof Error ? error.message : String(error),
					severity: "error",
				})
			}
		}

		return {
			isValid: errors.length === 0,
			errors,
		}
	}

	private calculateStructuralComplexity(node: t.Node): number {
		let complexity = 1 // Base complexity
		let childCount = 0

		traverse(t.file(t.program([t.expressionStatement(node as any)])), {
			enter: () => {
				childCount++
			},
		})

		// Factor in nesting depth and number of children
		complexity += Math.log(childCount + 1)

		// Additional complexity for certain node types
		if (t.isLoop(node)) complexity += 2
		if (t.isConditional(node)) complexity += 1.5
		if (t.isTryStatement(node)) complexity += 2

		return complexity
	}

	private async applyAstChanges(
		ast: t.File,
		changes: AstChange[],
		originalSignatures: NodeSignature,
	): Promise<AstModificationResult> {
		let appliedChanges = 0
		let totalNodes = 0
		let matchedNodes = 0
		let complexityScore = 0

		const metrics: AstMetrics = this.initializeMetrics()
		const self = this // Preserve class instance context

		traverse(ast, {
			Program(path) {
				changes.forEach((change) => {
					totalNodes++
					const targetPath = path.get("body")[parseInt(change.path[1], 10)]
					if (!targetPath) return

					// Calculate structural complexity
					complexityScore += self.calculateStructuralComplexity(targetPath.node)

					switch (change.type) {
						case "insert":
							if (change.value) {
								const newNode = parser.parse(change.value).program.body[0]
								if (t.isStatement(newNode)) {
									targetPath.insertBefore(newNode)
									appliedChanges++
									matchedNodes++
								}
							}
							break
						case "update":
							if (change.value) {
								const updatedNode = parser.parse(change.value).program.body[0]
								if (t.isStatement(updatedNode)) {
									const similarity = self.calculateNodeSimilarity(targetPath.node, updatedNode)
									if (similarity >= self.fuzzyMatchThreshold) {
										targetPath.replaceWith(updatedNode)
										appliedChanges++
										matchedNodes++
									}
								}
							}
							break
						case "delete":
							targetPath.remove()
							appliedChanges++
							matchedNodes++
							break
					}
				})
			},
		})

		// Update metrics
		metrics.nodeMatchAccuracy = matchedNodes / totalNodes
		metrics.structuralComplexity = complexityScore / totalNodes
		metrics.accuracyScore = appliedChanges / changes.length

		return { ast, appliedChanges, metrics }
	}
}
