Option Explicit

' wscript.exe is a GUI-subsystem process. WshShell.Run with window style 0
' starts the Node host with a real but hidden console. The app-server and all
' later console descendants inherit that console instead of asking the user's
' default terminal application to create visible windows.

Dim shell
Dim fileSystem
Dim nodePath
Dim hostPath
Dim requestPath
Dim resultPath
Dim command
Dim launchResult

If WScript.Arguments.Count <> 4 Then
  WScript.Quit 64
End If

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

nodePath = CStr(WScript.Arguments.Item(0))
hostPath = CStr(WScript.Arguments.Item(1))
requestPath = CStr(WScript.Arguments.Item(2))
resultPath = CStr(WScript.Arguments.Item(3))

If Not fileSystem.FileExists(nodePath) Then
  WriteFailureResult resultPath, "Node executable is missing"
  WScript.Quit 2
End If
If Not fileSystem.FileExists(hostPath) Then
  WriteFailureResult resultPath, "hidden console host script is missing"
  WScript.Quit 3
End If
If Not fileSystem.FileExists(requestPath) Then
  WriteFailureResult resultPath, "hidden console launch request is missing"
  WScript.Quit 4
End If

command = QuoteArgument(nodePath) _
  & " " & QuoteArgument(hostPath) _
  & " --request " & QuoteArgument(requestPath) _
  & " --result " & QuoteArgument(resultPath)

shell.CurrentDirectory = fileSystem.GetParentFolderName(hostPath)
On Error Resume Next
launchResult = shell.Run(command, 0, False)
If Err.Number <> 0 Then
  WriteFailureResult resultPath, "wscript failed to start the hidden console host"
  WScript.Quit 1
End If
On Error GoTo 0

WScript.Quit 0

Function QuoteArgument(ByVal value)
  QuoteArgument = Chr(34) & CStr(value) & Chr(34)
End Function

Sub WriteFailureResult(ByVal outputPath, ByVal message)
  Dim output
  On Error Resume Next
  Set output = fileSystem.CreateTextFile(outputPath, True, False)
  output.Write "{""version"":1,""ok"":false,""error"":""" _
    & Replace(CStr(message), Chr(34), "'") & """}"
  output.Close
  On Error GoTo 0
End Sub
