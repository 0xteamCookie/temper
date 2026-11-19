export const TRUEFORGE_VERSION = '0.185.0';
export const TRUEFORGE_NPX = `npx -y @truefoundry/trueforge@${TRUEFORGE_VERSION}`;
/** TrueForge only lets agents reach MCP servers on hosts in this list; Temper's MCP server is on 127.0.0.1. */
export const OUTBOUND_HOSTS = '["127.0.0.1"]';

/** The start command for the user's shell, with the outbound-host setting Temper needs. */
export function trueforgeCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? `$env:OUTBOUND_URL_ALLOWED_HOSTS='${OUTBOUND_HOSTS}'; ${TRUEFORGE_NPX}`
    : `OUTBOUND_URL_ALLOWED_HOSTS='${OUTBOUND_HOSTS}' ${TRUEFORGE_NPX}`;
}
