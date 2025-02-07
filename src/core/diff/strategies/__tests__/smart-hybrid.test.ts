import { SmartHybridStrategy } from "../smart-hybrid"
import { DiffResult } from "../../types"

describe("SmartHybridStrategy", () => {
	let strategy: SmartHybridStrategy

	beforeEach(() => {
		strategy = new SmartHybridStrategy()
	})

	describe("applyDiff", () => {
		it("should successfully apply a simple diff", async () => {
			const original = 'function hello() {\n  return "world";\n}'
			const diff = `<<<<<<< SEARCH
function hello() {
  return "world";
}
=======
function hello() {
  return "hello world";
}
>>>>>>> REPLACE`

			const result = await strategy.applyDiff(original, diff)
			expect(result.success).toBe(true)
			if (result.success) {
				expect(result.content).toBe('function hello() {\n  return "hello world";\n}')
			}
		})

		it("should handle CBOR encoded content", async () => {
			// Create a CBOR encoded string prefixed with base64:
			const cborData = Buffer.from([0xd9, 0x00, ...Buffer.from("test content")])
			const original = "base64:" + cborData.toString("base64")
			const diff = `<<<<<<< SEARCH
test content
=======
modified content
>>>>>>> REPLACE`

			const result = await strategy.applyDiff(original, diff)
			expect(result.success).toBe(true)
		})

		it("should utilize cache for repeated operations", async () => {
			const original = "const x = 1;"
			const diff = `<<<<<<< SEARCH
const x = 1;
=======
const x = 2;
>>>>>>> REPLACE`

			// First operation
			const result1 = await strategy.applyDiff(original, diff, { collectMetrics: true })
			expect(result1.success).toBe(true)

			// Second operation (should hit cache)
			const result2 = await strategy.applyDiff(original, diff, { collectMetrics: true })
			expect(result2.success).toBe(true)

			if (result1.success && result2.success && result1.metrics && result2.metrics) {
				expect(result2.metrics.executionTime).toBeLessThan(result1.metrics.executionTime)
			}
		})

		it("should handle large content with SIMD acceleration", async () => {
			const original = "a".repeat(10000)
			const diff = `<<<<<<< SEARCH
${"a".repeat(100)}
=======
${"b".repeat(100)}
>>>>>>> REPLACE`

			const result = await strategy.applyDiff(original, diff, { collectMetrics: true })
			expect(result.success).toBe(true)
		})

		it("should return error for non-matching content", async () => {
			const original = "function test() {}"
			const diff = `<<<<<<< SEARCH
nonexistent content
=======
new content
>>>>>>> REPLACE`

			const result = await strategy.applyDiff(original, diff)
			expect(result.success).toBe(false)
			if (!result.success) {
				expect(result.error).toBe("Search content not found in original content")
			}
		})

		it("should handle invalid diff format", async () => {
			const original = "test content"
			const diff = "invalid diff format"

			const result = await strategy.applyDiff(original, diff)
			expect(result.success).toBe(false)
			if (!result.success) {
				expect(result.error).toBe("Invalid diff format")
			}
		})

		// Go language support tests
		it("should handle Go function modifications", async () => {
			const original = `
package main

func Add(a, b int) int {
    return a + b
}`
			const diff = `<<<<<<< SEARCH
func Add(a, b int) int {
    return a + b
}
=======
func Add(a, b int) int {
    sum := a + b
    return sum
}
>>>>>>> REPLACE`

			const result = await strategy.applyDiff(original, diff, {
				fileStats: { path: "math.go", size: 100, lastModified: new Date() },
			})
			expect(result.success).toBe(true)
		})

		it("should handle Go type definitions", async () => {
			const original = `
package main

type User struct {
    Name string
    Age  int
}`
			const diff = `<<<<<<< SEARCH
type User struct {
    Name string
    Age  int
}
=======
type User struct {
    Name     string
    Age      int
    Email    string
}
>>>>>>> REPLACE`

			const result = await strategy.applyDiff(original, diff, {
				fileStats: { path: "types.go", size: 100, lastModified: new Date() },
			})
			expect(result.success).toBe(true)
		})

		it("should handle Go import statements", async () => {
			const original = `
package main

import (
    "fmt"
    "strings"
)`
			const diff = `<<<<<<< SEARCH
import (
    "fmt"
    "strings"
)
=======
import (
    "fmt"
    "strings"
    "time"
)
>>>>>>> REPLACE`

			const result = await strategy.applyDiff(original, diff, {
				fileStats: { path: "main.go", size: 100, lastModified: new Date() },
			})
			expect(result.success).toBe(true)
		})
	})

	describe("getToolDescription", () => {
		it("should return a valid tool description", () => {
			const description = strategy.getToolDescription({ cwd: "/" })
			expect(description).toContain("Smart Hybrid Diff Strategy")
			expect(description).toContain("SIMD-accelerated content chunking")
			expect(description).toContain("Multi-tier caching system")
			expect(description).toContain("Go language support")
		})
	})
})
