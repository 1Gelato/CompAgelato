@echo off
rem A executer UNE SEULE FOIS : cree un raccourci "CompaGelato" sur le
rem Bureau. Ensuite, utilisez ce raccourci pour lancer le logiciel — vous
rem n'aurez plus besoin de ce dossier ni d'une invite de commandes.
setlocal
set "here=%~dp0"
set "target=%here%launch.vbs"
set "icon=%here%build\icon.ico"
set "desktop=%USERPROFILE%\Desktop\CompaGelato.lnk"

powershell -NoProfile -Command "$s = (New-Object -COM WScript.Shell).CreateShortcut('%desktop%'); $s.TargetPath = '%target%'; $s.WorkingDirectory = '%here%'; $s.IconLocation = '%icon%'; $s.Description = 'CompaGelato'; $s.Save()"

if exist "%desktop%" (
  echo.
  echo Raccourci cree sur le Bureau : CompaGelato
  echo Vous pouvez desormais fermer cette fenetre et double-cliquer sur ce raccourci.
) else (
  echo.
  echo Le raccourci n'a pas pu etre cree. Copiez ce message et montrez-le pour obtenir de l'aide.
)
echo.
pause
