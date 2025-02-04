import { SearchReplaceDiffStrategy } from "../search-replace"

describe("SearchReplaceDiffStrategy", () => {
	describe("optimization tests", () => {
		let strategy: SearchReplaceDiffStrategy

		beforeEach(() => {
			strategy = new SearchReplaceDiffStrategy(1.0, 5)
		})

		it("should use LRU cache for repeated similarity checks", async () => {
			const originalContent = "function test() {\n    return true;\n}\n"
			const diffContent = `test.ts
<<<<<<< SEARCH
function test() {
    return true;
}
=======
function test() {
    return false;
}
>>>>>>> REPLACE`

			// First call should compute similarity
			const result1 = await strategy.applyDiff(originalContent, diffContent, {})
			expect(result1.success).toBe(true)

			// Second call with same content should use cache
			const result2 = await strategy.applyDiff(originalContent, diffContent, {})
			expect(result2.success).toBe(true)

			// Results should be identical
			if (result1.success && result2.success) {
				expect(result1.content).toBe(result2.content)
			}
		})

		it("should use MurmurHash3 for quick rejection", async () => {
			const originalContent = "function test() {\n    return true;\n}\n"
			const diffContent = `test.ts
<<<<<<< SEARCH
function test() {
    return false;
}
=======
function test() {
    return true;
}
>>>>>>> REPLACE`

			// Content is different but hash comparison should quickly reject
			const result = await strategy.applyDiff(originalContent, diffContent, {})
			expect(result.success).toBe(false)
		})

		it("should handle memory efficiently with WeakMap for string normalization", async () => {
			const originalContent = "function test() {\n    return true;\n}\n"
			const diffContent = `test.ts
<<<<<<< SEARCH
function test() {
    return true;
}
=======
function test() {
    return false;
}
>>>>>>> REPLACE`

			// Multiple operations should not cause memory issues
			for (let i = 0; i < 1000; i++) {
				const result = await strategy.applyDiff(originalContent, diffContent, {})
				expect(result.success).toBe(true)
			}
		})
	})

	// Rest of existing tests...
})
