Option Explicit

' Task Scheduler launches console executables in the interactive user session.
' Passing -WindowStyle Hidden to powershell.exe is too late to prevent the
' console host from flashing while PowerShell starts.  wscript.exe is a GUI
' subsystem host, so launching PowerShell through WshShell.Run with style 0
' creates no visible console window.

Dim shell
Dim fileSystem
Dim scriptDirectory
Dim powershellPath
Dim watchdogPath
Dim command
Dim exitCode

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
powershellPath = shell.ExpandEnvironmentStrings("%SystemRoot%") _
  & "\System32\WindowsPowerShell\v1.0\powershell.exe"
watchdogPath = fileSystem.BuildPath(scriptDirectory, "cyberboss-watchdog.ps1")

If Not fileSystem.FileExists(powershellPath) Then
  WScript.Quit 2
End If
If Not fileSystem.FileExists(watchdogPath) Then
  WScript.Quit 3
End If

command = QuoteArgument(powershellPath) _
  & " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " _
  & QuoteArgument(watchdogPath) _
  & " -Mode Once"

' A test-only inspection switch verifies the resolved command without running
' the watchdog or changing any service/task state.
If WScript.Arguments.Count > 0 Then
  If LCase(WScript.Arguments.Item(0)) = "--print-command" Then
    WScript.Echo command
    WScript.Quit 0
  End If
  WScript.Quit 64
End If

shell.CurrentDirectory = scriptDirectory
On Error Resume Next
exitCode = shell.Run(command, 0, True)
If Err.Number <> 0 Then
  WScript.Quit 1
End If
On Error GoTo 0

WScript.Quit CInt(exitCode)

Function QuoteArgument(ByVal value)
  QuoteArgument = Chr(34) & Replace(CStr(value), Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
