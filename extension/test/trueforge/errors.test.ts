import { describe, expect, it } from 'vitest';
import { classifyFailure, isFallbackEligible, isRetryable } from '../../src/trueforge';

describe('classifyFailure', () => {
  it.each([
    ['[Model Error] Cannot connect to API: connect ECONNREFUSED 127.0.0.1:11434', 'unreachable'],
    ['[Model Error] Request failed (401): mock 401', 'auth'],
    ['[Model Error] Request failed (403): nope', 'auth'],
    ['[Model Error] Request failed (429): mock 429', 'rateLimit'],
    ['[Model Error] Request failed (500): mock 500', 'server'],
    ['[Model Error] Request failed (503): down', 'server'],
    ['[Model Error] Request failed (400): bad', 'model'],
    ['[Model Error] something odd', 'model'],
    ["[MCP Error] Failed to connect to remote MCP server 'spike-fs': failed to connect", 'mcp'],
    ['Unknown model "x/y" - provider not configured', 'unknownModel'],
    ['whatever', 'other'],
  ])('%s -> %s', (msg, kind) => {
    expect(classifyFailure(msg)).toBe(kind);
  });

  it('classifies http statuses', () => {
    expect(classifyFailure(422)).toBe('unknownModel');
    expect(classifyFailure(401)).toBe('auth');
    expect(classifyFailure(429)).toBe('rateLimit');
    expect(classifyFailure(502)).toBe('server');
    expect(classifyFailure(400)).toBe('other');
  });

  it('retry and fallback eligibility', () => {
    expect(isRetryable('rateLimit')).toBe(true);
    expect(isRetryable('server')).toBe(true);
    expect(isRetryable('auth')).toBe(false);
    expect(isFallbackEligible('mcp')).toBe(false);
    expect(isFallbackEligible('other')).toBe(false);
    expect(isFallbackEligible('unreachable')).toBe(true);
  });
});
