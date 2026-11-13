import type { WorkspaceReader } from '../../src/context';

export function memReader(files: Record<string, string>): WorkspaceReader {
  const store = new Map(Object.entries(files));
  return {
    root: '/mem',
    listFiles: () => Promise.resolve([...store.keys()].sort()),
    readFile: (rel) => Promise.resolve(store.get(rel)),
  };
}

export const TOY: Record<string, string> = {
  'src/app/__init__.py': 'from .cli import main\n',
  'src/app/cli.py': [
    'import click',
    'from .helpers import get_debug_flag',
    '',
    'class Group(click.Group):',
    '    """A command group."""',
    '',
    '    def list_commands(self, ctx):',
    '        """List the commands."""',
    '        return ["run", "routes"]',
    '',
    '@click.command("run")',
    'def run_command(host, port):',
    '    """Run the development server."""',
    '    if get_debug_flag():',
    '        print("debug")',
    '',
    'def main():',
    '    return 0',
    '',
  ].join('\n'),
  'src/app/helpers.py': ['def get_debug_flag():', '    """Whether debug mode is on."""', '    return False', ''].join('\n'),
  'tests/test_cli.py': ['from app.cli import run_command', '', 'def test_run_command():', '    assert run_command', ''].join('\n'),
  'docs/cli.rst': ['Command Line Interface', '======================', '', 'The ``flask`` command runs the server.', '', 'Run', '---', '', 'Use run_command.', ''].join('\n'),
  'README.md': '# Toy\n\nA toy project.\n',
  'assets/logo.png': 'not really a png',
};
