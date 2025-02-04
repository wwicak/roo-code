# ADR 008: AST-Aware Diff Strategy Improvements

## Context

The current AST-aware diff strategy implementation has several areas for improvement in terms of precision, performance, and intelligence. This ADR proposes enhancements to make the strategy more robust and efficient.

## Key Improvements

### 1. Structural AST Matching

- Replace line-based change tracking with node signature matching
- Implement node hashing for quick structural comparisons
- Use tree-diff algorithm for detecting structural changes

```typescript
interface NodeSignature {
	type: string
	hash: string
	children: NodeSignature[]
}
```

### 2. Performance Optimizations

- Implement AST caching using content hashing
- Cache parsed ASTs in memory with LRU eviction policy
- Reuse AST for multiple operations within same session

```typescript
interface AstCache {
	contentHash: string
	ast: t.File
	lastUsed: number
}
```

### 3. Intelligent Node Matching

- Implement fuzzy matching for similar nodes
- Score node similarity based on structure and content
- Support partial matches for more flexible updates

```typescript
interface NodeMatch {
	node: t.Node
	similarity: number
	matchedPaths: string[]
}
```

### 4. Enhanced Error Handling

- Add pre-validation of AST modifications
- Provide detailed error context with node paths
- Support partial success with fallback options

```typescript
interface ValidationResult {
	isValid: boolean
	errors: Array<{
		path: string[]
		message: string
		severity: "error" | "warning"
	}>
}
```

### 5. Metrics & Observability

- Track AST operation performance
- Measure node matching accuracy
- Report structural change complexity

```typescript
interface AstMetrics extends DiffMetrics {
	nodeMatchAccuracy: number
	structuralComplexity: number
	cacheHitRate: number
}
```

## Implementation Strategy

1. Create new AST utility classes for:

    - Node signature generation
    - Tree diffing
    - AST caching
    - Validation

2. Enhance the core AstAwareStrategy class with:

    - Improved node traversal
    - Intelligent matching
    - Metrics collection

3. Add new test cases covering:
    - Complex structural changes
    - Edge cases
    - Performance scenarios

## Benefits

- More precise code modifications
- Better performance through caching
- Improved error handling and diagnostics
- Better metrics for optimization

## Risks

- Increased complexity in AST handling
- Memory usage from caching
- Potential performance impact from detailed matching

## Alternatives Considered

- Pure text-based diffing: Less precise
- Line-based AST mapping: Less flexible
- Full tree comparison: Too expensive

## Decision

Implement the proposed improvements incrementally, starting with:

1. Node signatures and structural matching
2. AST caching
3. Enhanced metrics
4. Intelligent node matching
5. Improved error handling

## Status

Proposed

## Consequences

### Positive

- More accurate code modifications
- Better performance for repeated operations
- Improved debugging capabilities

### Negative

- Increased code complexity
- Higher memory usage
- More complex testing requirements

## References

- [Babel AST Specification](https://github.com/babel/babel/blob/main/packages/babel-parser/ast/spec.md)
- [Tree Edit Distance Algorithms](https://en.wikipedia.org/wiki/Tree_edit_distance)
- [LRU Cache Implementation](<https://en.wikipedia.org/wiki/Cache_replacement_policies#Least_recently_used_(LRU)>)
