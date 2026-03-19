/**
 * Tests for sequential mode validation.
 * JSON validation in schema.ts (isJson path) — validateArtifact
 *
 * Note: MCP integration tests for artifact_write sequential mode were removed
 * as they depend on old state format infrastructure. They will be rewritten
 * when proper integration test infrastructure is available.
 */

import { describe, it, expect } from 'vitest';
import { validateArtifact } from '../src/core/schema.js';
import type { ArtifactSchema } from '../src/core/types.js';

// ─── JSON Validation (schema.ts isJson path) ───

describe('validateArtifact — JSON mode', () => {
    const jsonSchema: ArtifactSchema = {
        jsonFields: [
            { field: 'features', required: true, type: 'array', minItems: 1 },
            { field: 'constraints', required: false, type: 'array' },
            { field: 'scope', required: true, type: 'string' },
            { field: 'priorities', required: false, type: 'object' },
        ],
    };

    it('should pass with valid JSON and all required fields', () => {
        const content = JSON.stringify({
            features: ['auth', 'dashboard'],
            constraints: ['budget < 50k'],
            scope: 'MVP release',
            priorities: { auth: 'P0' },
        });
        const result = validateArtifact(content, jsonSchema, false, true);
        expect(result.valid).toBe(true);
    });

    it('should fail on invalid JSON', () => {
        const result = validateArtifact('{ broken json }', jsonSchema, false, true);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.type === 'invalid_json')).toBe(true);
    });

    it('should fail when required field is missing', () => {
        const content = JSON.stringify({ features: ['auth'] });
        const result = validateArtifact(content, jsonSchema, false, true);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.type === 'missing_json_field' && e.message.includes('scope'))).toBe(true);
    });

    it('should skip optional fields', () => {
        const content = JSON.stringify({ features: ['auth'], scope: 'small mvp' });
        const result = validateArtifact(content, jsonSchema, false, true);
        expect(result.valid).toBe(true);
    });

    it('should fail on wrong type', () => {
        const content = JSON.stringify({ features: 'should be array', scope: 'test' });
        const result = validateArtifact(content, jsonSchema, false, true);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.type === 'wrong_json_type')).toBe(true);
    });

    it('should fail on array minItems violation', () => {
        const content = JSON.stringify({ features: [], scope: 'test' });
        const result = validateArtifact(content, jsonSchema, false, true);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.type === 'json_array_too_short')).toBe(true);
    });

    it('should not check markdown sections in JSON mode', () => {
        const mixedSchema: ArtifactSchema = {
            sections: [{ heading: '## Required', required: true }],
            jsonFields: [{ field: 'data', required: true, type: 'string' }],
        };
        const result = validateArtifact(JSON.stringify({ data: 'hello' }), mixedSchema, false, true);
        expect(result.valid).toBe(true);
    });

    it('should still check minLength in JSON mode', () => {
        const s: ArtifactSchema = {
            jsonFields: [{ field: 'x', required: true, type: 'string' }],
            minLength: 500,
        };
        const result = validateArtifact(JSON.stringify({ x: 'short' }), s, false, true);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.type === 'content_too_short')).toBe(true);
    });
});
