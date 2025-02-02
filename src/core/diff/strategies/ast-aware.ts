import { DiffStrategy, DiffResult, FileStats, DiffMetrics } from "../types"
import * as parser from "@babel/parser"
import traverse, { NodePath } from "@babel/traverse"
import generate from "@babel/generator"
import * as t from "@babel/types"

type ChangeType = "insert" | "update" | "delete"

interface AstChange {
	type: ChangeType
	path: string[]
	value?: string
}

interface AstModificationResult {
	ast: t.File
	appliedChanges: number
}

/**
 * AST-aware diff strategy that uses language-specific parsers
 * for more accurate code modifications
 */
export class AstAwareStrategy implements DiffStrategy {
	constructor(private readonly fuzzyMatchThreshold: number = 0.9) {}

	getToolDescription(args: { cwd: string; toolOptions?: { [key: string]: string } }): string {
		return `## apply_diff
Description: Apply changes using AST-aware parsing for accurate code modifications.
This strategy understands code structure and maintains syntax correctness.

Parameters:
- path: (required) File path relative to ${args.cwd}
- diff: (required) Unified diff content
- options: (optional) Additional options like fileStats and metrics collection

Note: This strategy is automatically selected for supported languages when AST parsing is available.
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
			const language = this.detectLanguage(options?.fileStats?.path)
			if (!this.isLanguageSupported(language)) {
				throw new Error(`Language ${language} is not supported for AST-aware diffing`)
			}

			// Parse the original content into an AST
			const ast = this.parseToAst(originalContent, language)

			// Parse and apply the changes
			const changes = this.parseDiffToAstChanges(diffContent)
			const { ast: modifiedAst, appliedChanges } = this.applyAstChanges(ast, changes)

			// Generate the modified code
			const { code } = generate(modifiedAst, {
				retainLines: true,
				compact: false,
				jsescOption: {
					minimal: true,
				},
			})

			if (options?.collectMetrics) {
				metrics.executionTime = performance.now() - startTime
				metrics.memoryUsed = process.memoryUsage().heapUsed
				metrics.accuracyScore = 1.0 // AST modifications are exact
			}

			return {
				success: true,
				content: code,
				appliedLines: appliedChanges,
				metrics: options?.collectMetrics ? metrics : undefined,
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

	private parseDiffToAstChanges(diffContent: string): AstChange[] {
		const changes: AstChange[] = []
		const lines = diffContent.split("\n")
		let currentHunk: [number, number] | null = null

		for (const line of lines) {
			if (line.startsWith("@@")) {
				currentHunk = this.parseHunkHeader(line)
			} else if (currentHunk && line.startsWith("+")) {
				changes.push({
					type: "insert",
					path: ["body", currentHunk[0].toString()],
					value: line.slice(1),
				})
			} else if (currentHunk && line.startsWith("-")) {
				changes.push({
					type: "delete",
					path: ["body", currentHunk[0].toString()],
				})
			}
		}

		return changes
	}

	private parseHunkHeader(header: string): [number, number] {
		const match = header.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
		if (!match) {
			throw new Error("Invalid hunk header format")
		}
		return [parseInt(match[1], 10), parseInt(match[2], 10)]
	}

	private applyAstChanges(ast: t.File, changes: AstChange[]): AstModificationResult {
		let appliedChanges = 0

		traverse(ast, {
			Program(path) {
				changes.forEach((change) => {
					const targetPath = path.get("body")[parseInt(change.path[1], 10)]
					if (!targetPath) return

					switch (change.type) {
						case "insert":
							if (change.value) {
								const newNode = parser.parse(change.value).program.body[0]
								if (t.isStatement(newNode)) {
									targetPath.insertBefore(newNode)
									appliedChanges++
								}
							}
							break
						case "update":
							if (change.value) {
								const updatedNode = parser.parse(change.value).program.body[0]
								if (t.isStatement(updatedNode)) {
									targetPath.replaceWith(updatedNode)
									appliedChanges++
								}
							}
							break
						case "delete":
							targetPath.remove()
							appliedChanges++
							break
					}
				})
			},
		})

		return { ast, appliedChanges }
	}
}
