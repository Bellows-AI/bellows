/**
 * A task's one-line title: the first line of the command that was asked, trimmed — multi-line
 * prose must not swallow the title. The ONE derivation for the sidenav, the inbox and the detail
 * view; every panel that used to split the command itself calls this.
 */
export function taskTitleFromCommand(command: string): string {
    return command.split('\n')[0]!.trim();
}
