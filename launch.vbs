' Lance CompaGelato sans faire apparaitre de fenetre noire (invite de
' commandes). C'est ce fichier que le raccourci du Bureau doit viser.
' En cas d'echec au demarrage, le journal (launch.log, ecrit par launch.bat)
' s'ouvre automatiquement dans le Bloc-notes pour pouvoir le transmettre.
'
' Note : les chemins sont entoures de guillemets construits avec Chr(34)
' plutot qu'avec des guillemets doubles imbriques dans le code source, pour
' eviter toute ambiguite d'interpretation par l'invite de commandes.

Dim fso, shell, scriptDir, q, batPath, logPath, exitCode

Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = scriptDir

q = Chr(34)
batPath = scriptDir & "\launch.bat"
logPath = scriptDir & "\launch.log"

' 0 = fenetre masquee, True = attendre la fin (le logiciel tourne tant que
' la fenetre de CompaGelato est ouverte).
exitCode = shell.Run(q & batPath & q, 0, True)

If exitCode <> 0 Then
  If fso.FileExists(logPath) Then
    shell.Run "notepad.exe " & q & logPath & q, 1, False
  Else
    MsgBox "CompaGelato n'a pas pu demarrer (code " & exitCode & ") et aucun journal n'a ete produit." & vbCrLf & "Verifiez que Node.js est installe, puis contactez le support.", vbExclamation, "CompaGelato"
  End If
End If
