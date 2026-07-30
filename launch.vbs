' Lance CompaGelato sans faire apparaitre de fenetre noire (invite de
' commandes). C'est ce fichier que le raccourci du Bureau doit viser.
' En cas d'echec au demarrage, le journal s'ouvre automatiquement dans
' le Bloc-notes pour pouvoir le transmettre facilement.

Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = scriptDir

logFile = scriptDir & "\launch.log"
command = "cmd /c """ & scriptDir & "\launch.bat"" > """ & logFile & """ 2>&1"

' 0 = fenetre masquee, True = attendre la fin (le logiciel tourne tant que
' la fenetre de CompaGelato est ouverte).
exitCode = shell.Run(command, 0, True)

If exitCode <> 0 Then
  shell.Run "notepad.exe """ & logFile & """", 1, False
End If
