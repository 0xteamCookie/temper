import { describe, expect, it } from 'vitest';
import { TRUEFORGE_NPX, trueforgeCommand } from '../../src/host/trueforgeStart';

describe('trueforgeCommand', () => {
  it('pins the version and skips the npx prompt', () => {
    expect(TRUEFORGE_NPX).toBe('npx -y @truefoundry/trueforge@0.185.0');
  });

  it('sets the outbound host list for PowerShell on Windows', () => {
    expect(trueforgeCommand('win32')).toBe(
      `$env:HOST='127.0.0.1'; $env:OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'; ${TRUEFORGE_NPX}`,
    );
  });

  it('sets the outbound host list inline on POSIX shells', () => {
    expect(trueforgeCommand('darwin')).toBe(`HOST=127.0.0.1 OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' ${TRUEFORGE_NPX}`);
  });
});
