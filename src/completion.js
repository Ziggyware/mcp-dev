// Dynamic completion deliberately uses the local metadata cache for tool names:
// tab completion stays instant and never starts a server process or contacts a
// remote endpoint. `mcp-dev tools <server>` refreshes that cache.

export const COMMANDS = [
  "register", "unregister", "list", "tools", "call", "ask", "session", "doctor", "completion", "help",
];

function bashScript() {
  return `# mcp-dev bash completion
# Install: mcp-dev completion bash >> ~/.bashrc
_mcp_dev_servers() { mcp-dev list --plain 2>/dev/null; }
_mcp_dev_tools() { mcp-dev tools "$1" --plain --cached 2>/dev/null; }
_mcp_dev_completions() {
  local cur prev cword words sub server
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cword=$COMP_CWORD
  local commands="${COMMANDS.join(" ")}"

  if [[ $cword -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$commands --help --version" -- "$cur") )
    return 0
  fi

  sub="\${COMP_WORDS[1]}"
  case "$sub" in
    help)
      if [[ $cword -eq 2 ]]; then COMPREPLY=( $(compgen -W "$commands" -- "$cur") ); fi ;;
    unregister|tools)
      if [[ $cword -eq 2 ]]; then COMPREPLY=( $(compgen -W "$(_mcp_dev_servers)" -- "$cur") ); fi
      ;;
    call)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "$(_mcp_dev_servers)" -- "$cur") )
      elif [[ $cword -eq 3 ]]; then
        server="\${COMP_WORDS[2]}"; COMPREPLY=( $(compgen -W "$(_mcp_dev_tools "$server")" -- "$cur") )
      else
        COMPREPLY=( $(compgen -W "--args --args-file --json --dry-run --timeout" -- "$cur") )
      fi
      ;;
    ask)
      if [[ "$prev" == "-s" || "$prev" == "--server" ]]; then COMPREPLY=( $(compgen -W "$(_mcp_dev_servers)" -- "$cur") ); fi
      ;;
    completion)
      if [[ $cword -eq 2 ]]; then COMPREPLY=( $(compgen -W "bash zsh pwsh" -- "$cur") ); fi ;;
    register)
      COMPREPLY=( $(compgen -W "--url --command --arg --args --cwd --root --env --header --description --inherit-env --allow-sampling --force" -- "$cur") ) ;;
    doctor)
      COMPREPLY=( $(compgen -W "--timeout --concurrency --json" -- "$cur") ) ;;
  esac
}
complete -F _mcp_dev_completions mcp-dev
`;
}

function zshScript() {
  return `#compdef mcp-dev
# mcp-dev zsh completion
# Install: mcp-dev completion zsh > "\${fpath[1]}/_mcp-dev"
_mcp_dev() {
  local -a commands servers tools
  commands=(${COMMANDS.map((command) => `'${command}'`).join(" ")})
  servers=(\${(f)"$(mcp-dev list --plain 2>/dev/null)"})

  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi

  local sub="\${words[2]}"
  case "$sub" in
    help)
      if (( CURRENT == 3 )); then _describe 'command' commands; fi ;;
    unregister|tools)
      if (( CURRENT == 3 )); then _describe 'server' servers; fi ;;
    call)
      if (( CURRENT == 3 )); then
        _describe 'server' servers
      elif (( CURRENT == 4 )); then
        tools=(\${(f)"$(mcp-dev tools "\${words[3]}" --plain --cached 2>/dev/null)")
        _describe 'tool' tools
      else
        _values 'option' '--args[JSON object]' '--args-file[JSON file]:file:_files' '--json[raw MCP result]' '--dry-run[do not execute]' '--timeout[request timeout in ms]'
      fi ;;
    ask)
      if [[ "\${words[CURRENT-1]}" == "-s" || "\${words[CURRENT-1]}" == "--server" ]]; then _describe 'server' servers; fi ;;
    completion)
      if (( CURRENT == 3 )); then _values 'shell' bash zsh pwsh; fi ;;
  esac
}
_mcp_dev
`;
}

function pwshScript() {
  return `# mcp-dev PowerShell completion
# Install: mcp-dev completion pwsh >> $PROFILE
Register-ArgumentCompleter -Native -CommandName mcp-dev -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    $commands = @(${COMMANDS.map((command) => `'${command}'`).join(", ")})
    $tokens = @($commandAst.CommandElements | ForEach-Object { $_.ToString() })
    function Result($value) { [System.Management.Automation.CompletionResult]::new($value, $value, 'ParameterValue', $value) }
    function Servers { try { mcp-dev list --plain 2>$null } catch { @() } }
    function Tools($server) { try { mcp-dev tools $server --plain --cached 2>$null } catch { @() } }

    if ($tokens.Count -le 2) {
        @($commands + '--help' + '--version') | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { Result $_ }
        return
    }
    $sub = $tokens[1]
    if ($sub -eq 'help' -and $tokens.Count -eq 3) { $commands | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { Result $_ }; return }
    if (($sub -eq 'unregister' -or $sub -eq 'tools') -and $tokens.Count -eq 3) { Servers | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { Result $_ }; return }
    if ($sub -eq 'call') {
        if ($tokens.Count -eq 3) { Servers | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { Result $_ }; return }
        if ($tokens.Count -eq 4) { Tools $tokens[2] | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { Result $_ }; return }
    }
    if ($sub -eq 'ask' -and ($tokens[-2] -eq '-s' -or $tokens[-2] -eq '--server')) { Servers | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { Result $_ }; return }
    if ($sub -eq 'completion' -and $tokens.Count -eq 3) { @('bash','zsh','pwsh') | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { Result $_ } }
}
`;
}

export function generateCompletionScript(shell) {
  switch (shell) {
    case "bash": return bashScript();
    case "zsh": return zshScript();
    case "pwsh": return pwshScript();
    default: throw new Error(`Unsupported shell "${shell}" — expected bash, zsh, or pwsh.`);
  }
}
