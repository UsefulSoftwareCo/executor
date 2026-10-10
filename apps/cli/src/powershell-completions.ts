const completionScript = `# Register with: executor --completions pwsh | Invoke-Expression
#
# The completer reads Executor's contextual help at completion time. That keeps
# commands and flags aligned with the installed CLI without a second command tree.
Register-ArgumentCompleter -Native -CommandName executor -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)

  $elements = @($commandAst.CommandElements | ForEach-Object { $_.Extent.Text })
  $arguments = @($elements | Select-Object -Skip 1)
  if ($arguments.Count -gt 0 -and $arguments[-1] -eq $wordToComplete) {
    $arguments = @($arguments | Select-Object -SkipLast 1)
  }

  $help = & executor @arguments --help 2>$null
  if ($LASTEXITCODE -ne 0) {
    return
  }

  $previous = if ($arguments.Count -gt 0) { $arguments[-1] } else { "" }
  if ($previous -like '--*') {
    $escapedFlag = [regex]::Escape($previous)
    $choiceLine = $help | Where-Object {
      $_ -match "^\\s+$escapedFlag\\s+choice\\s+.*\\(choices:\\s+(.+)\\)$"
    } | Select-Object -First 1
    if ($choiceLine -match '\\(choices:\\s+(.+)\\)$') {
      $choices = @($matches[1] -split ',\\s*')
      if ($previous -eq '--completions') { $choices += 'pwsh' }
      $choices |
        Where-Object { $_ -like "$wordToComplete*" } |
        Sort-Object -Unique |
        ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
      return
    }
  }

  $section = ""
  $candidates = foreach ($line in $help) {
    if ($line -match '^[A-Z ]+$') {
      $section = $line.Trim()
      continue
    }

    if ($wordToComplete.StartsWith('-') -and ($section -eq 'GLOBAL FLAGS' -or $section -eq 'FLAGS')) {
      if ($line -match '^\\s+(--[a-z0-9-]+)(?:,\\s+(-[a-z]))?\\s{2,}') {
        $matches[1]
        if ($matches[2]) { $matches[2] }
      }
      continue
    }

    if (-not $wordToComplete.StartsWith('-') -and $section -eq 'SUBCOMMANDS') {
      if ($line -match '^\\s+([a-z][a-z0-9-]*)\\s{2,}') {
        $matches[1]
      }
    }
  }

  $candidates |
    Where-Object { $_ -like "$wordToComplete*" } |
    Sort-Object -Unique |
    ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
}
`;

export const generatePowerShellCompletions = (): string => completionScript;
