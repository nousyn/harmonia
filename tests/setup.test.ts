/**
 * Tests for cli/setup.ts — parseSetupArgs.
 *
 * The setup command now only registers a project in the registry.
 */

import { describe, it, expect } from 'vitest';
import { parseSetupArgs } from '../src/cli/setup.js';

describe('cli/setup parseSetupArgs', () => {
    it('should parse project name', () => {
        const opts = parseSetupArgs(['my-app']);
        expect(opts.projectName).toBe('my-app');
    });

    it('should parse --dir option', () => {
        const opts = parseSetupArgs(['my-app', '--dir', '/path/to/project']);
        expect(opts.projectName).toBe('my-app');
        expect(opts.dir).toBe('/path/to/project');
    });

    it('should parse --workflow option', () => {
        const opts = parseSetupArgs(['my-app', '--workflow', 'custom']);
        expect(opts.projectName).toBe('my-app');
        expect(opts.workflow).toBe('custom');
    });

    it('should parse all options together', () => {
        const opts = parseSetupArgs(['my-app', '--dir', '/src', '--workflow', 'dev']);
        expect(opts.projectName).toBe('my-app');
        expect(opts.dir).toBe('/src');
        expect(opts.workflow).toBe('dev');
    });

    it('should throw when project name is missing', () => {
        expect(() => parseSetupArgs([])).toThrow('Project name is required');
    });

    it('should throw on unknown option', () => {
        expect(() => parseSetupArgs(['my-app', '--unknown'])).toThrow('Unknown option');
    });

    it('should throw on extra positional argument', () => {
        expect(() => parseSetupArgs(['my-app', 'extra'])).toThrow('Unexpected argument');
    });

    it('should throw when --dir has no value', () => {
        expect(() => parseSetupArgs(['my-app', '--dir'])).toThrow('--dir requires a value');
    });

    it('should throw when --workflow has no value', () => {
        expect(() => parseSetupArgs(['my-app', '--workflow'])).toThrow('--workflow requires a value');
    });
});
