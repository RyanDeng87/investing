# Registers a Windows Scheduled Task that runs the IV collector on weekdays,
# HIDDEN (no console window). The action launches the Electron binary directly
# in headless --collector mode: electron.exe is a GUI-subsystem app and the
# collector never opens a window, so nothing is visible. Running under the
# current user's interactive logon keeps Windows DPAPI able to decrypt the
# stored API keys. You can also manage this task from the app:
#   Settings -> Scheduled collector (change days/time, disable, or cancel it).
$ErrorActionPreference = 'Stop'

$ProjectDir = Split-Path -Parent $PSScriptRoot
$TaskName = 'InvestingApp IV Collector'
$LocalTime = '14:50'
$Electron = Join-Path $ProjectDir 'node_modules\electron\dist\electron.exe'

if (-not (Test-Path $Electron)) {
  throw "Electron binary not found at $Electron - run 'npm install' first."
}
if (-not (Test-Path (Join-Path $ProjectDir 'out\main\index.js'))) {
  Write-Warning "out\main\index.js not found - run 'npm run build' so the collector has compiled code to run."
}

$action = New-ScheduledTaskAction -Execute $Electron `
  -Argument "`"$ProjectDir`" --collector" -WorkingDirectory $ProjectDir
$trigger = New-ScheduledTaskTrigger -Weekly `
  -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday -At $LocalTime
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

Write-Output "Registered '$TaskName': weekdays at $LocalTime local, running the collector hidden (no console window)."
Write-Output "Change the days/time, disable, or cancel it from the app: Settings -> Scheduled collector."
Write-Output "StartWhenAvailable is on - if the PC is asleep at trigger time, it runs on wake."
Write-Output "Note: the task runs the compiled code in out\ - run 'npm run build' after code changes."
