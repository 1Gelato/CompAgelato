@echo off
rem Lance CompaGelato. Ce fichier est appele par launch.vbs (raccourci du
rem Bureau) : il ne doit normalement jamais etre ouvert directement.
rem La sortie est enregistree dans launch.log pour faciliter le depannage.
cd /d "%~dp0"
call npm start > "%~dp0launch.log" 2>&1
exit /b %errorlevel%
