// src/completion.js
//
// Item 20: shell completion. Server names are NOT baked into the generated
// script -- `listServers()` in config.js is only consulted at completion
// *time*, via each script shelling back out to `mcp-dev list --plain`, so a
// server registered or removed after the script was generated is reflected
// immediately without regenerating anything.

const COMMANDS = ["register", "unregister", "list", "tools", "call", "ask", "session", "doctor", "completion"];

function bashScript() {
  return `# mcp-dev bash completion
# Install: mcp-dev completion bash >> ~/.bashrc   (or source it from your shell rc)
_mcp_dev_completions() {
  local cur prev cword words
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cword=$COMP_CWORD

  local commands="${COMMANDS.join(" ")}"

  if [[ $cword -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    return 0
  fi

  local sub="\${COMP_WORDS[1]}"
  case "$sub" in
    tools|unregister)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "$(mcp-dev list --plain 2>/dev/null)" -- "$cur") )
      fi
      ;;
    call)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "$(mcp-dev list --plain 2>/dev/null)" -- "$cur") )
      fi
      ;;
    ask)
      if [[ "$prev" == "-s" || "$prev" == "--server" ]]; then
        COMPREPLY=( $(compgen -W "$(mcp-dev list --plain 2>/dev/null)" -- "$cur") )
      fi
      ;;
    completion)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "bash zsh pwsh" -- "$cur") )
      fi
      ;;
  esac
}
complete -F _mcp_dev_completions mcp-dev
`;
}

function zshScript() {
  return `#compdef mcp-dev
# mcp-dev zsh completion
# Install: mcp-dev completion zsh > "\${fpath[1]}/_mcp-dev"   (then restart your shell)
_mcp_dev() {
  local -a commands
  commands=(${COMMANDS.map((c) => `'${c}'`).join(" ")})

  local -a servers
  servers=(\${(f)"$(mcp-dev list --plain 2>/dev/null)"})

  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi

  local sub="\${words[2]}"
  case "$sub" in
    tools|unregister|call)
      if (( CURRENT == 3 )); then
        _describe 'server' servers
      fi
      ;;
    ask)
      if [[ "\${words[CURRENT-1]}" == "-s" || "\${words[CURRENT-1]}" == "--server" ]]; then
        _describe 'server' servers
      fi
      ;;
    completion)
      if (( CURRENT == 3 )); then
        _values 'shell' bash zsh pwsh
      fi
      ;;
  esac
}
_mcp_dev
`;
}

function pwshScript() {
  return `# mcp-dev PowerShell completion
# Install: mcp-dev completion pwsh >> $PROFILE   (then restart your shell)
Register-ArgumentCompleter -Native -CommandName mcp-dev -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)

    $commands = @(${COMMANDS.map((c) => `'${c}'`).join(", ")})
    $tokens = $commandAst.CommandElements | ForEach-Object { $_.ToString() }

    function Get-McpDevServers {
        try { mcp-dev list --plain 2>$null } catch { @() }
    }

    if ($tokens.Count -le 2) {
        $commands | Where-Object { $_ -like "$wordToComplete*" } |
            ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
        return
    }

    $sub = $tokens[1]
    $serverPositionCommands = @('tools', 'unregister', 'call')

    if ($serverPositionCommands -contains $sub -and $tokens.Count -eq 3) {
        Get-McpDevServers | Where-Object { $_ -like "$wordToComplete*" } |
            ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
        return
    }

    if ($sub -eq 'ask' -and $tokens.Count -ge 2 -and ($tokens[-2] -eq '-s' -or $tokens[-2] -eq '--server')) {
        Get-McpDevServers | Where-Object { $_ -like "$wordToComplete*" } |
            ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
        return
    }

    if ($sub -eq 'completion' -and $tokens.Count -eq 3) {
        @('bash', 'zsh', 'pwsh') | Where-Object { $_ -like "$wordToComplete*" } |
            ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
    }
}
`;
}

export function generateCompletionScript(shell) {
  switch (shell) {
    case "bash": return bashScript();
    case "zsh": return zshScript();
    case "pwsh": return pwshScript();
    default:
      throw new Error(`Unsupported shell "${shell}" -- expected one of: bash, zsh, pwsh`);
  }
}

export { COMMANDS };