Option Explicit

' hidden-run.vbs - run a PowerShell script with no visible console window.
'
' Task Scheduler starts a console executable inside the interactive session, and
' powershell.exe -WindowStyle Hidden is parsed only after its console already
' exists.  This host hands console creation to Windows Terminal, so a task whose
' action is powershell.exe paints a terminal window on the user's desktop for
' every run (measured with a SetWinEventHook watcher: a visible
' CASCADIA_HOSTING_WINDOW_CLASS / PseudoConsoleWindow event pair, while the same
' PowerShell started through this wrapper produced only a hidden
' ConsoleWindowClass window).
'
' wscript.exe is a GUI-subsystem host, so WshShell.Run with style 0 creates the
' child's console hidden.  Usage:
'
'   wscript.exe //B //NoLogo hidden-run.vbs <script.ps1> [args...]

Dim shell
Dim fileSystem
Dim scriptPath
Dim command
Dim index
Dim exitCode

If WScript.Arguments.Count < 1 Then WScript.Quit 64

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

scriptPath = WScript.Arguments.Item(0)
If Not fileSystem.FileExists(scriptPath) Then WScript.Quit 65

command = Quote(shell.ExpandEnvironmentStrings("%SystemRoot%") _
  & "\System32\WindowsPowerShell\v1.0\powershell.exe") _
  & " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " _
  & Quote(scriptPath)
For index = 1 To WScript.Arguments.Count - 1
  command = command & " " & QuoteIfNeeded(WScript.Arguments.Item(index))
Next

On Error Resume Next
exitCode = shell.Run(command, 0, True)
If Err.Number <> 0 Then WScript.Quit 1
On Error GoTo 0

If Not IsNumeric(exitCode) Then WScript.Quit 0
If exitCode < 0 Or exitCode > 255 Then WScript.Quit 1
WScript.Quit CInt(exitCode)

Function Quote(ByVal value)
  Quote = Chr(34) & Replace(CStr(value), Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function

' Parameter names such as -Mode must reach PowerShell unquoted to bind.
Function QuoteIfNeeded(ByVal value)
  If InStr(value, " ") > 0 Or InStr(value, Chr(9)) > 0 Or InStr(value, Chr(34)) > 0 Then
    QuoteIfNeeded = Quote(value)
  Else
    QuoteIfNeeded = value
  End If
End Function
