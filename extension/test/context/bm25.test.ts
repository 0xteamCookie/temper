import { describe, expect, it } from 'vitest';
import { Bm25Index, splitIdentifier, tokenize } from '../../src/context';

describe('tokenizer', () => {
  it('splits camelCase, snake_case and punctuation', () => {
    expect(splitIdentifier('getDebugFlag')).toEqual(['get', 'Debug', 'Flag']);
    expect(splitIdentifier('HTTPServerError')).toEqual(['HTTP', 'Server', 'Error']);
    const t = tokenize('def get_debug_flag(): return FlaskGroup.parseArgs');
    expect(t).toContain('get_debug_flag');
    expect(t).toEqual(expect.arrayContaining(['debug', 'flag', 'flask', 'group', 'parse', 'arg']));
  });
  it('drops stopwords and stems plurals', () => {
    const t = tokenize('the commands and the options');
    expect(t).toEqual(['command', 'option']);
  });
});

describe('Bm25Index', () => {
  it('ranks the best matching doc first and supports remove', () => {
    const idx = new Bm25Index();
    idx.add('a', tokenize('run the development server with debug flag'));
    idx.add('b', tokenize('render a template from a string'));
    idx.add('c', tokenize('debug debug debug flag handling and server'));
    const hits = idx.search(tokenize('debug flag'), 5);
    expect(hits[0]?.id).toBe('c');
    expect(hits.map((h) => h.id)).not.toContain('b');
    idx.remove('c');
    expect(idx.search(tokenize('debug flag'))[0]?.id).toBe('a');
    expect(idx.size).toBe(2);
  });
});
