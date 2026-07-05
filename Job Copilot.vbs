' Double-click to launch Job Application Intelligence Copilot (Phase 2).
' Previous-session cleanup is handled inside launch_copilot.bat (Streamlit only).

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
repoRoot = fso.GetParentFolderName(WScript.ScriptFullName)
batPath = repoRoot & "\copilot\launch_copilot.bat"

If Not fso.FileExists(batPath) Then
    MsgBox "Launcher not found: " & batPath, vbCritical, "Job Copilot"
    WScript.Quit 1
End If

shell.CurrentDirectory = repoRoot
shell.Run """" & batPath & """", 1, False
